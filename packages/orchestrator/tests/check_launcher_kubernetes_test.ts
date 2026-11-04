// The kubernetes check launcher: the Job it writes (the contract with the check pod), what its
// pod status reads as, and a suite's life against a fake API server — created suspended, its
// Secret owned by it, released; polled; its logs read; discarded.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  CHECK_COMPONENT,
  type CheckJobManifest,
  checkJobManifest,
  type CheckPod,
  checkSecretManifest,
  JOB_DEADLINE_BACKSTOP_SECONDS,
  kubernetesCheckLauncher,
  ownDiskEviction,
  readCheckJob,
  SERVICE_RESTART_LIMIT,
  SUSPENDED_GRACE_MS,
  UNSCHEDULABLE_GRACE_MS,
} from "../src/adapters/check_launcher/kubernetes.ts";
import type { KubernetesOptions } from "../src/adapters/provisioner/kubernetes.ts";
import type { CheckSpec } from "../src/ports/check_launcher.ts";
import type { ServiceSpec } from "../src/core/types.ts";
import { CHECK_PLATFORM_EXIT } from "../src/core/checks.ts";
import { CHECK_POOL_EXIT } from "../src/core/check_types.ts";
import { silentDiagnostics, UNSIZED } from "./doubles.ts";

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const CLAIM = "http://cs-1:claim-token@egress-proxy.ryph-egress.svc:7460";

const SPEC: CheckSpec = {
  suiteId: "cs-0123456789",
  generation: 2,
  name: "ryph-check-cs-0123456789-g2",
  image: "registry.test/ryph-envs/repo@sha256:" + "d".repeat(64),
  clone: {
    url: "http://forge.ryph.svc:7412/v1/git/cs-0123456789/cr-1/repo.git",
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.http://forge.ryph.svc:7412/.extraheader",
      GIT_CONFIG_VALUE_0: "Authorization: Basic Z2l0LWtleS1zZWNyZXQ=",
    },
    commit: HEAD,
    baseCommit: BASE,
  },
  bakedCheckout: null,
  keep: ["node_modules"],
  setup: [{ run: "npm ci" }, { run: "npm run build" }],
  checks: [
    { name: "lint", run: "npm run lint", timeoutSeconds: 300 },
    { name: "test", run: "npm test -- --reporter dot", timeoutSeconds: 900 },
  ],
  services: [],
  size: { ...UNSIZED, name: "standard", cpu: "4", memory: "8Gi", ephemeralStorage: "10Gi" },
  proxyEnv: {
    HTTPS_PROXY: CLAIM,
    HTTP_PROXY: CLAIM,
    https_proxy: CLAIM,
    http_proxy: CLAIM,
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
  },
  deadlineSeconds: 2400,
};

const DB: ServiceSpec = {
  name: "postgres",
  image: "postgres@sha256:" + "e".repeat(64),
  env: { POSTGRES_PASSWORD: "postgres" },
  port: 5432,
  security: { capabilities: ["SETUID", "SETGID"], allowPrivilegeEscalation: false },
  resources: { cpus: "1", memory: "1g" },
};

const OPTS: KubernetesOptions = {
  apiUrl: "https://kube.test",
  namespace: "ryph-runs",
  tokenFile: null,
  caFile: null,
  serviceAccount: "ryph-run",
  runtimeClass: "gvisor",
  runUser: { uid: 1994, gid: 1994 },
};

const SECRET = "ryph-check-cs-0123456789-g2-0badcafe";

const podSpec = (job: CheckJobManifest) => (job.spec.template as Json).spec;
const container = (job: CheckJobManifest, name: string) =>
  [...podSpec(job).initContainers, ...podSpec(job).containers].find((c: Json) => c.name === name);
const envNames = (c: Json) => (c.env ?? []).map((e: Json) => e.name);

test("the Job is suspended, retry-free, deadline-bound and labelled check-run", () => {
  const job = checkJobManifest(SPEC, OPTS, SECRET);
  assertEquals(job.metadata.name, SPEC.name);
  assertEquals(job.metadata.namespace, "ryph-runs");
  assertEquals(job.spec.suspend, true);
  assertEquals(job.spec.backoffLimit, 0);
  // The Job's deadline is a later backstop; the suite's is the pod's, which keeps the pod.
  assertEquals(job.spec.activeDeadlineSeconds, 2400 + JOB_DEADLINE_BACKSTOP_SECONDS);
  assertEquals(job.spec.ttlSecondsAfterFinished, 3600);
  const labels = {
    "app.kubernetes.io/managed-by": "ryph",
    "app.kubernetes.io/component": "check-run",
    "ryph.check": "cs-0123456789",
    "ryph.check-generation": "2",
  };
  assertEquals(job.metadata.labels, labels);
  assertEquals((job.spec.template as Json).metadata.labels, labels);
  // Never agent-run: that label's policy reaches the control plane.
  assertEquals(CHECK_COMPONENT, "check-run");
  const pod = podSpec(job);
  assertEquals(pod.activeDeadlineSeconds, 2400);
  assertEquals(pod.restartPolicy, "Never");
  assertEquals(pod.automountServiceAccountToken, false);
  // Named, never the cluster's globalDefault: real work must outrank reserved capacity.
  assertEquals(pod.priorityClassName, "ryph-workload");
  assertEquals(pod.enableServiceLinks, false);
  assertEquals(pod.serviceAccountName, "ryph-run");
  assertEquals(pod.runtimeClassName, "gvisor");
  assertEquals(pod.securityContext.seccompProfile, { type: "RuntimeDefault" });
  // No compute class asked for, no node selector.
  assertEquals(pod.nodeSelector, undefined);
});

test("a check compute class becomes the pod's node selector", () => {
  const job = checkJobManifest(SPEC, { ...OPTS, checkComputeClass: "ryph-checks" }, SECRET);
  assertEquals(podSpec(job).nodeSelector, { "cloud.google.com/compute-class": "ryph-checks" });
});

test("the pod runs clone, then setup in order, then every check together", () => {
  const job = checkJobManifest(SPEC, OPTS, SECRET);
  assertEquals(podSpec(job).initContainers.map((c: Json) => c.name), [
    "clone",
    "setup-0",
    "setup-1",
  ]);
  assertEquals(podSpec(job).containers.map((c: Json) => c.name), ["check-lint", "check-test"]);
  for (const c of [...podSpec(job).initContainers, ...podSpec(job).containers]) {
    assertEquals(c.image, SPEC.image);
    // The image's ENTRYPOINT is overridden: a platform script, never the head's or the runner.
    // Nor the harness's tini: a baked image has no harness layer to carry it.
    assertEquals(c.command.slice(0, 2), ["/bin/bash", "-c"]);
    assertEquals(c.securityContext, {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      runAsNonRoot: true,
      runAsUser: 1994,
      runAsGroup: 1994,
    });
    assertEquals(c.envFrom, undefined);
  }
});

test("only the clone sees the git credential, and only by reference", () => {
  const job = checkJobManifest(SPEC, OPTS, SECRET);
  const body = JSON.stringify(job);
  assert(!body.includes("Z2l0LWtleS1zZWNyZXQ="), "the credential is in the Job body");
  assert(!body.includes("claim-token"), "the egress claim is in the Job body");
  const clone = container(job, "clone");
  const gitRefs = clone.env.filter((e: Json) => e.name.startsWith("GIT_CONFIG_"));
  assertEquals(gitRefs.map((e: Json) => e.valueFrom.secretKeyRef), [
    { name: SECRET, key: "clone.GIT_CONFIG_COUNT" },
    { name: SECRET, key: "clone.GIT_CONFIG_KEY_0" },
    { name: SECRET, key: "clone.GIT_CONFIG_VALUE_0" },
  ]);
  assertEquals(
    Object.fromEntries(
      clone.env.filter((e: Json) => "value" in e).map((e: Json) => [e.name, e.value]),
    ),
    {
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
      RYPH_CHECK_URL: SPEC.clone.url,
      RYPH_CHECK_HEAD: HEAD,
      RYPH_CHECK_BASE: BASE,
    },
  );
  // No egress claim for the clone: the gateway is reached directly.
  assert(!envNames(clone).some((n: string) => /proxy/i.test(n)));
  for (const name of ["setup-0", "setup-1", "check-lint", "check-test"]) {
    const c = container(job, name);
    assert(
      !envNames(c).some((n: string) => n.startsWith("GIT_CONFIG_") || n === "RYPH_CHECK_URL"),
      `${name} holds a git credential`,
    );
    assert(
      !JSON.stringify(c).includes("clone."),
      `${name} references the clone's secret keys`,
    );
  }
});

test(
  "setup and checks get the egress claim from the Secret, and commands as env values",
  () => {
    const job = checkJobManifest(SPEC, OPTS, SECRET);
    const testCheck = container(job, "check-test");
    const byName = Object.fromEntries(testCheck.env.map((e: Json) => [e.name, e]));
    assertEquals(byName.RYPH_CHECK_RUN.value, "npm test -- --reporter dot");
    assertEquals(byName.RYPH_CHECK_TIMEOUT.value, "900");
    assertEquals(byName.HTTPS_PROXY.valueFrom.secretKeyRef, {
      name: SECRET,
      key: "proxy.HTTPS_PROXY",
    });
    assertEquals(byName.NO_PROXY.value, "localhost,127.0.0.1");
    // The command is never in the script text or argv.
    assert(!testCheck.command.join("\n").includes("npm test"));
    const setup = container(job, "setup-1");
    assertEquals(setup.env.find((e: Json) => e.name === "RYPH_CHECK_STEP").value, "npm run build");
    assertEquals(setup.env.find((e: Json) => e.name === "RYPH_CHECK_STEP_INDEX").value, "1");
    assert(!setup.command.join("\n").includes("npm run build"));
  },
);

test("checks mount the pristine tree read-only, their own pool directory, and a work volume", () => {
  const job = checkJobManifest(SPEC, OPTS, SECRET);
  assertEquals(container(job, "clone").volumeMounts, [{
    name: "pristine",
    mountPath: "/pristine",
  }]);
  assertEquals(container(job, "setup-0").volumeMounts, [
    { name: "pristine", mountPath: "/pristine" },
  ]);
  // Its own pool directory read-write, every other check's read-only: no check writes where
  // another's watcher does.
  assertEquals(container(job, "check-lint").volumeMounts, [
    { name: "pristine", mountPath: "/pristine", readOnly: true },
    { name: "pool-lint", mountPath: "/pool/lint" },
    { name: "pool-test", mountPath: "/pool/test", readOnly: true },
    { name: "work-lint", mountPath: "/work" },
  ]);
  assertEquals(container(job, "check-test").volumeMounts, [
    { name: "pristine", mountPath: "/pristine", readOnly: true },
    { name: "pool-lint", mountPath: "/pool/lint", readOnly: true },
    { name: "pool-test", mountPath: "/pool/test" },
    { name: "work-test", mountPath: "/work" },
  ]);
  // Three whole trees (pristine and one per check) share the class's 10Gi; the pool directories'
  // few bytes are the pod's.
  assertEquals(podSpec(job).volumes, [
    { name: "pristine", emptyDir: { sizeLimit: "3413Mi" } },
    { name: "pool-lint", emptyDir: { sizeLimit: "64Ki" } },
    { name: "pool-test", emptyDir: { sizeLimit: "64Ki" } },
    { name: "work-lint", emptyDir: { sizeLimit: "3413Mi" } },
    { name: "work-test", emptyDir: { sizeLimit: "3413Mi" } },
  ]);
  const unsized = checkJobManifest(
    { ...SPEC, size: { ...SPEC.size, ephemeralStorage: null } },
    OPTS,
    SECRET,
  );
  assertEquals(podSpec(unsized).volumes[0], { name: "pristine", emptyDir: {} });
});

test("each check asks for and is limited to its share; init containers get all of it", () => {
  const job = checkJobManifest(SPEC, OPTS, SECRET);
  // The limits sum to the class: under gVisor, the pod's one cap.
  const share = { cpu: "2000m", memory: "4Gi", "ephemeral-storage": "5Gi" };
  assertEquals(container(job, "check-lint").resources, { requests: share, limits: share });
  assertEquals(container(job, "check-test").resources, { requests: share, limits: share });
  assert(!("resources" in podSpec(job)));
  const whole = { cpu: "4", memory: "8Gi", "ephemeral-storage": "10240Mi" };
  assertEquals(container(job, "clone").resources, { requests: whole, limits: whole });
  assertEquals(container(job, "setup-1").resources, { requests: whole, limits: whole });
  // What the pool watcher is told: the class's memory, and this check's half of it.
  const values = Object.fromEntries(
    container(job, "check-test").env.filter((e: Json) => "value" in e).map((
      e: Json,
    ) => [e.name, e.value]),
  );
  assertEquals(values.RYPH_CHECK_NAME, "test");
  assertEquals(values.RYPH_CHECK_POOL, "/pool");
  assertEquals(values.RYPH_CHECK_NAMES, "lint test");
  assertEquals(values.RYPH_CHECK_POOL_BYTES, String(8 * 2 ** 30));
  assertEquals(values.RYPH_CHECK_SHARE_BYTES, String(4 * 2 ** 30));
  // Only the checks share the pool.
  for (const name of ["clone", "setup-0"]) {
    assert(!JSON.stringify(container(job, name)).includes("RYPH_CHECK_POOL"));
  }
  // A class with no memory has no pool to watch.
  const unsized = checkJobManifest({ ...SPEC, size: UNSIZED }, OPTS, SECRET);
  assert(!envNames(container(unsized, "check-lint")).includes("RYPH_CHECK_POOL_BYTES"));
  assert(!podSpec(unsized).volumes.some((v: Json) => v.name.startsWith("pool-")));
  assert(
    !container(unsized, "check-lint").volumeMounts.some((m: Json) => m.name.startsWith("pool-")),
  );
});

const BAKED: CheckSpec = { ...SPEC, bakedCheckout: "repo" };

test(
  "a baked checkout: no setup containers, no work volumes; each check sets up in its own layer",
  () => {
    const job = checkJobManifest({ ...BAKED, services: [DB] }, OPTS, SECRET);
    const pod = podSpec(job);
    // The services follow the clone directly: setup is in the checks now.
    assertEquals(pod.initContainers.map((c: Json) => c.name), ["clone", "svc-postgres"]);
    assertEquals(pod.containers.map((c: Json) => c.name), ["check-lint", "check-test"]);
    // The clone is the same in both shapes, credential and all.
    assertEquals(
      container(job, "clone"),
      container(checkJobManifest({ ...SPEC, services: [DB] }, OPTS, SECRET), "clone"),
    );
    const lint = container(job, "check-lint");
    assertEquals(lint.volumeMounts, [
      { name: "pristine", mountPath: "/pristine", readOnly: true },
      { name: "pool-lint", mountPath: "/pool/lint" },
      { name: "pool-test", mountPath: "/pool/test", readOnly: true },
    ]);
    // One tree volume, the clone's, under the same cap; each check's tree is its own writable
    // layer, held by the same share of the class's disk it always had.
    assertEquals(podSpec(checkJobManifest(BAKED, OPTS, SECRET)).volumes, [
      { name: "pristine", emptyDir: { sizeLimit: "3413Mi" } },
      { name: "pool-lint", emptyDir: { sizeLimit: "64Ki" } },
      { name: "pool-test", emptyDir: { sizeLimit: "64Ki" } },
    ]);
    // (10Gi less the service's 1Gi) / 2.
    const share = { cpu: "2000m", memory: "4Gi", "ephemeral-storage": "4608Mi" };
    assertEquals(lint.resources, { requests: share, limits: share });
    const values = Object.fromEntries(
      lint.env.filter((e: Json) => "value" in e).map((e: Json) => [e.name, e.value]),
    );
    assertEquals(values.RYPH_CHECK_BAKED, "/ryph/work/repo");
    assertEquals(values.RYPH_CHECK_HEAD, HEAD);
    assertEquals(values.RYPH_CHECK_SETUP_COUNT, "2");
    assertEquals(values.RYPH_CHECK_SETUP_0, "npm ci");
    assertEquals(values.RYPH_CHECK_SETUP_1, "npm run build");
    assertEquals(values.RYPH_CHECK_KEEP_COUNT, "1");
    assertEquals(values.RYPH_CHECK_KEEP_0, "node_modules");
    // No credential reaches a check, and no setup command is in its script.
    assert(
      !envNames(lint).some((n: string) => n.startsWith("GIT_CONFIG_") || n === "RYPH_CHECK_URL"),
    );
    assert(!JSON.stringify(lint).includes("clone."));
    assert(!lint.command.join("\n").includes("npm ci"));
    assertStringIncludes(lint.command[2], 'tree="$RYPH_CHECK_BAKED"');
    assert(
      !container(checkJobManifest(SPEC, OPTS, SECRET), "check-lint").command[2].includes(
        "RYPH_CHECK_BAKED",
      ),
    );
  },
);

test("a baked check over its share fails alone with exit 1, its setup included", () => {
  const job = checkJobManifest(BAKED, OPTS, SECRET);
  const baked: CheckJobManifest = {
    ...job,
    metadata: { ...job.metadata, uid: "job-uid-2", creationTimestamp: ago(60_000) },
    spec: { ...job.spec, suspend: false },
  };
  const read = readCheckJob(
    baked,
    pod({ clone: done(0) }, {
      "check-lint": done(0),
      "check-test": { state: { running: { startedAt: "2026-09-30T11:58:30Z" } } },
    }, {
      phase: "Failed",
      reason: "Evicted",
      message: 'Container check-test exceeded its local ephemeral storage limit "4Gi". ',
    }),
    NOW,
  );
  assert(read.kind === "checks");
  assertEquals(read.done, true);
  assertEquals((read.checks.test as Json).exitCode, 1);
  assertEquals((read.checks.test as Json).reason, "used more disk than its share (4Gi)");
  assertEquals((read.checks.lint as Json).exitCode, 0);
  // With only the clone before them, the checks run once it is done.
  const running = readCheckJob(
    baked,
    pod({ clone: done(0) }, { "check-lint": { state: { running: {} } } }),
    NOW,
  );
  assert(running.kind === "checks" && !running.done);
});

test("a class too small to split is refused naming it, before anything is created", () => {
  const tiny = {
    ...SPEC,
    size: { ...SPEC.size, name: "tiny", memory: "768Mi" },
  };
  let error = "";
  try {
    checkJobManifest(tiny, OPTS, SECRET);
  } catch (err) {
    error = String(err);
  }
  assertStringIncludes(error, 'size class "tiny"');
  assertStringIncludes(error, "384Mi for each of its 2 checks");
});

test("services are sidecars AFTER setup, reachable by name, their disk off the checks'", () => {
  const job = checkJobManifest({ ...SPEC, services: [DB] }, OPTS, SECRET);
  const pod = podSpec(job);
  assertEquals(pod.initContainers.map((c: Json) => c.name), [
    "clone",
    "setup-0",
    "setup-1",
    "svc-postgres",
  ]);
  assertEquals(pod.initContainers[3].restartPolicy, "Always");
  // No startupProbe: the checks start with the service and wait on it themselves, so one that
  // never answers ends in the platform's exit code rather than holding the pod to its deadline.
  assertEquals(pod.initContainers[3].startupProbe, undefined);
  // The disk the sidecar leaves, split between three trees.
  assertEquals(pod.volumes[0].emptyDir, { sizeLimit: "3072Mi" });
  assertEquals(pod.hostAliases, [{ ip: "127.0.0.1", hostnames: ["postgres"] }]);
  const check = container(job, "check-test");
  const byName = Object.fromEntries(check.env.map((e: Json) => [e.name, e]));
  assertEquals(byName.RYPH_CHECK_SERVICES.value, "postgres:5432");
  // A client honouring HTTP_PROXY must not send the service to the proxy.
  assertEquals(byName.NO_PROXY.value, "localhost,127.0.0.1,postgres");
  assertEquals(byName.no_proxy.value, "localhost,127.0.0.1,postgres");
  // 10Gi less the sidecar's 1Gi, split two ways.
  assertEquals(check.resources.limits["ephemeral-storage"], "4608Mi");
});

test("the Secret holds the clone's credential and the claim, owned by the Job", () => {
  const secret = checkSecretManifest(SPEC, OPTS, "u-1", SECRET);
  assertEquals(secret.metadata.name, SECRET);
  assertEquals(secret.metadata.ownerReferences, [
    { apiVersion: "batch/v1", kind: "Job", name: SPEC.name, uid: "u-1" },
  ]);
  assertEquals(secret.stringData["clone.GIT_CONFIG_VALUE_0"], SPEC.clone.env.GIT_CONFIG_VALUE_0);
  assertEquals(secret.stringData["proxy.HTTPS_PROXY"], CLAIM);
  assertEquals("proxy.NO_PROXY" in secret.stringData, false);
});

test("a spec with a malformed name, check name or commit is refused", () => {
  for (
    const bad of [
      { ...SPEC, name: "Ryph Check" },
      { ...SPEC, checks: [{ name: "../x", run: "true", timeoutSeconds: 1 }] },
      { ...SPEC, checks: [SPEC.checks[0], SPEC.checks[0]] },
      { ...SPEC, clone: { ...SPEC.clone, commit: "HEAD" } },
      { ...SPEC, checks: [] },
    ]
  ) {
    let threw = false;
    try {
      checkJobManifest(bad, OPTS, SECRET);
    } catch {
      threw = true;
    }
    assert(threw, JSON.stringify(bad.name));
  }
});

// ── reading the pod ─────────────────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-09-30T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function released(status?: CheckJobManifest["status"]): CheckJobManifest {
  const job = checkJobManifest(SPEC, OPTS, SECRET);
  return {
    ...job,
    metadata: { ...job.metadata, uid: "job-uid-2", creationTimestamp: ago(60_000) },
    spec: { ...job.spec, suspend: false },
    ...(status ? { status } : {}),
  };
}

const done = (exitCode: number, reason?: string) => ({
  state: {
    terminated: {
      exitCode,
      reason,
      startedAt: "2026-09-30T11:58:00Z",
      finishedAt: "2026-09-30T11:59:00Z",
    },
  },
});

function pod(
  init: Record<string, Json>,
  main: Record<string, Json> = {},
  extra: Json = {},
): CheckPod {
  return {
    metadata: { name: "p-1", creationTimestamp: ago(30_000) },
    status: {
      phase: "Running",
      initContainerStatuses: Object.entries(init).map(([name, s]) => ({ name, ...s })),
      containerStatuses: Object.entries(main).map(([name, s]) => ({ name, ...s })),
      ...extra,
    },
  };
}

const SETUP_DONE = { clone: done(0), "setup-0": done(0), "setup-1": done(0) };

test("the verdict is each check container's exit code, read off the pod status", () => {
  const read = readCheckJob(
    released(),
    pod(SETUP_DONE, { "check-lint": done(0), "check-test": done(1) }),
    NOW,
  );
  assertEquals(read, {
    kind: "checks",
    done: true,
    checks: {
      lint: {
        state: "exited",
        exitCode: 0,
        startedAt: "2026-09-30T11:58:00Z",
        finishedAt: "2026-09-30T11:59:00Z",
        reason: null,
      },
      test: {
        state: "exited",
        exitCode: 1,
        startedAt: "2026-09-30T11:58:00Z",
        finishedAt: "2026-09-30T11:59:00Z",
        reason: null,
      },
    },
  });
});

test("a check still running is not done; OOMKilled rides along as the reason", () => {
  const read = readCheckJob(
    released(),
    pod(SETUP_DONE, {
      "check-lint": done(137, "OOMKilled"),
      "check-test": { state: { running: { startedAt: "2026-09-30T11:58:30Z" } } },
    }),
    NOW,
  );
  assert(read.kind === "checks");
  assertEquals(read.done, false);
  assertEquals((read.checks.lint as Json).reason, "OOMKilled");
  assertEquals(read.checks.test, { state: "running", startedAt: "2026-09-30T11:58:30Z" });
});

test("a check the pool watcher stopped is its own failure, naming its share and the pool", () => {
  const read = readCheckJob(
    released(),
    pod(SETUP_DONE, { "check-lint": done(CHECK_POOL_EXIT), "check-test": done(0) }),
    NOW,
  );
  assert(read.kind === "checks");
  assertEquals(read.checks.lint, {
    state: "exited",
    exitCode: CHECK_POOL_EXIT,
    startedAt: "2026-09-30T11:58:00Z",
    finishedAt: "2026-09-30T11:59:00Z",
    reason: "was stopped when the suite ran short of memory, as the check furthest over its " +
      "share (4Gi of the suite's 8Gi); its log says what it used",
  });
  assertEquals((read.checks.test as Json).reason, null);
});

test("clone and setup failures are setup_failed, naming the step", () => {
  assertEquals(readCheckJob(released(), pod({ clone: done(128) }), NOW), {
    kind: "setup_failed",
    cloneDone: false,
    step: "clone",
    exitCode: 128,
    why: "the clone exited 128",
  });
  assertEquals(
    readCheckJob(released(), pod({ clone: done(0), "setup-0": done(0), "setup-1": done(2) }), NOW),
    {
      kind: "setup_failed",
      cloneDone: true,
      step: 1,
      exitCode: 2,
      why: "setup step 2 exited 2",
    },
  );
});

test(
  "while cloning or setting up, the suite is pending and says whether the clone is done",
  () => {
    assertEquals(
      readCheckJob(released(), pod({ clone: { state: { running: {} } } }), NOW),
      { kind: "pending", cloneDone: false, why: "clone", running: "clone" },
    );
    assertEquals(
      readCheckJob(released(), pod({ clone: done(0), "setup-0": { state: { running: {} } } }), NOW),
      { kind: "pending", cloneDone: true, why: "setup-0", running: 0 },
    );
    // A step not started yet is not running: nothing of the head's is under way.
    assertEquals(
      readCheckJob(
        released(),
        pod({ clone: done(0), "setup-0": { state: { waiting: { reason: "PodInitializing" } } } }),
        NOW,
      ),
      { kind: "pending", cloneDone: true, why: "setup-0 (PodInitializing)" },
    );
    assertEquals(readCheckJob(released(), null, NOW), {
      kind: "pending",
      cloneDone: false,
      why: "waiting for a pod",
    });
  },
);

test("an image that will not pull is pending, then unschedulable past the grace", () => {
  const pulling = (age: number): CheckPod => ({
    ...pod({ clone: { state: { waiting: { reason: "ImagePullBackOff", message: "denied" } } } }),
    metadata: { name: "p-1", creationTimestamp: ago(age) },
  });
  assertEquals(readCheckJob(released(), pulling(60_000), NOW).kind, "pending");
  assertEquals(readCheckJob(released(), pulling(UNSCHEDULABLE_GRACE_MS + 1), NOW), {
    kind: "unschedulable",
    why: "clone: ImagePullBackOff: denied",
  });
  const unscheduled: CheckPod = {
    metadata: { name: "p-1", creationTimestamp: ago(UNSCHEDULABLE_GRACE_MS + 1) },
    status: {
      phase: "Pending",
      conditions: [{
        type: "PodScheduled",
        status: "False",
        reason: "Unschedulable",
        message: "0/3 nodes are available",
      }],
    },
  };
  // The scheduler's message names the cluster's nodes: the operator's to read, not the suite's.
  assertEquals(readCheckJob(released(), unscheduled, NOW), {
    kind: "unschedulable",
    why: null,
    detail: "Unschedulable: 0/3 nodes are available",
  });
});

test(
  "a pull that fails after a long setup gets a grace of its own, and says the clone is done",
  () => {
    const job = (() => {
      const j = checkJobManifest({ ...SPEC, services: [DB] }, OPTS, SECRET);
      return {
        ...j,
        metadata: { ...j.metadata, uid: "u", creationTimestamp: ago(3 * UNSCHEDULABLE_GRACE_MS) },
        spec: { ...j.spec, suspend: false },
      };
    })();
    const ended = (ms: number) => ({
      state: { terminated: { exitCode: 0, finishedAt: ago(ms), startedAt: ago(ms + 1000) } },
    });
    const pulling = (setupEndedAgo: number): CheckPod => ({
      ...pod({
        clone: ended(3 * UNSCHEDULABLE_GRACE_MS - 1000),
        "setup-0": ended(setupEndedAgo + 60_000),
        "setup-1": ended(setupEndedAgo),
        "svc-postgres": { state: { waiting: { reason: "ErrImagePull", message: "timeout" } } },
      }),
      // The pod is far past the grace; setup took most of it.
      metadata: { name: "p-1", creationTimestamp: ago(3 * UNSCHEDULABLE_GRACE_MS) },
    });
    assertEquals(readCheckJob(job, pulling(60_000), NOW), {
      kind: "pending",
      cloneDone: true,
      why: "svc-postgres: ErrImagePull: timeout",
    });
    assertEquals(readCheckJob(job, pulling(UNSCHEDULABLE_GRACE_MS + 1), NOW), {
      kind: "unschedulable",
      why: "svc-postgres: ErrImagePull: timeout",
    });
  },
);

const at = (iso: string, exitCode: number, reason?: string) => ({
  state: {
    terminated: { exitCode, reason, startedAt: "2026-09-30T11:00:00Z", finishedAt: iso },
  },
});

test("the pod's deadline: what it killed timed out, what had exited keeps its code", () => {
  // Started 11:00:00 with a 2400 s deadline: killed at 11:40:00.
  const deadline = {
    phase: "Failed",
    reason: "DeadlineExceeded",
    startTime: "2026-09-30T11:00:00Z",
  };
  const live = readCheckJob(
    released(),
    pod(SETUP_DONE, {
      "check-lint": at("2026-09-30T11:20:00Z", 1),
      "check-test": at("2026-09-30T11:40:01Z", 143),
    }, deadline),
    NOW,
  );
  assert(live.kind === "checks");
  assertEquals(live.done, true);
  // A check that failed by itself before the deadline keeps its own verdict.
  assertEquals((live.checks.lint as Json).exitCode, 1);
  assertEquals((live.checks.lint as Json).reason, null);
  assertEquals((live.checks.test as Json).reason, "DeadlineExceeded");
  // One the kubelet has not yet written an exit for is timed out all the same.
  const unwritten = readCheckJob(
    released(),
    pod(SETUP_DONE, { "check-lint": done(0), "check-test": { state: { running: {} } } }, deadline),
    NOW,
  );
  assert(unwritten.kind === "checks");
  assertEquals((unwritten.checks.lint as Json).exitCode, 0);
  assertEquals((unwritten.checks.test as Json).reason, "DeadlineExceeded");

  // A setup step the deadline killed ran out of time (124); a clone it killed is the platform's.
  assertEquals(
    readCheckJob(
      released(),
      pod({ clone: done(0), "setup-0": at("2026-09-30T11:40:00Z", 137) }, {}, deadline),
      NOW,
    ),
    {
      kind: "setup_failed",
      cloneDone: true,
      step: 0,
      exitCode: 124,
      why: "setup step 1 ran past the suite's deadline",
    },
  );
  assertEquals(
    readCheckJob(released(), pod({ clone: { state: { running: {} } } }, {}, deadline), NOW),
    {
      kind: "setup_failed",
      cloneDone: false,
      step: "clone",
      exitCode: null,
      why: "the clone ran past the suite's deadline",
    },
  );
});

test("the Job's backstop deadline, its pod deleted, times every check out", () => {
  const failed = { conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }] };
  const none = readCheckJob(released(failed), null, NOW);
  assert(none.kind === "checks");
  assertEquals(none.done, true);
  assertEquals((none.checks.lint as Json).reason, "DeadlineExceeded");
});

test("an evicted pod: the checks it cut short are the platform's, with the reason", () => {
  const read = readCheckJob(
    released(),
    pod(SETUP_DONE, { "check-lint": done(1), "check-test": done(137, "Error") }, {
      phase: "Failed",
      reason: "Evicted",
      message: "The node was low on resource: ephemeral-storage.",
    }),
    NOW,
  );
  assert(read.kind === "checks");
  assertEquals(read.done, true);
  // Exited 1 by itself: the head's. Killed by the eviction (no time to tell by, a signal's exit):
  // the platform's.
  assertEquals((read.checks.lint as Json).exitCode, 1);
  const testCheck = read.checks.test as Json;
  assertEquals(testCheck.exitCode, CHECK_PLATFORM_EXIT);
  assertStringIncludes(testCheck.reason, "Evicted: The node was low on resource");
  // No exit to show at all: the platform's too, never left waiting.
  const unwritten = readCheckJob(
    released(),
    pod(SETUP_DONE, { "check-lint": done(0) }, { phase: "Failed", reason: "Evicted" }),
    NOW,
  );
  assert(unwritten.kind === "checks");
  assertEquals(unwritten.done, true);
  assertEquals((unwritten.checks.test as Json).exitCode, CHECK_PLATFORM_EXIT);
});

test("an eviction for a check's own disk share fails that check alone, with exit 1", () => {
  const overVolume = {
    phase: "Failed",
    reason: "Evicted",
    message: 'Usage of EmptyDir volume "work-test" exceeds the limit "3276Mi". ',
  };
  const read = readCheckJob(
    released(),
    pod(SETUP_DONE, { "check-lint": done(137), "check-test": done(137) }, overVolume),
    NOW,
  );
  assert(read.kind === "checks");
  assertEquals(read.done, true);
  assertEquals((read.checks.test as Json).exitCode, 1);
  assertEquals((read.checks.test as Json).reason, "used more disk than its share (3276Mi)");
  // Its sibling was cut short by an eviction it did not cause: the platform's.
  assertEquals((read.checks.lint as Json).exitCode, CHECK_PLATFORM_EXIT);

  // The container's own limit, still shown running: the same.
  const overContainer = readCheckJob(
    released(),
    pod(SETUP_DONE, {
      "check-lint": done(0),
      "check-test": { state: { running: { startedAt: "2026-09-30T11:58:30Z" } } },
    }, {
      phase: "Failed",
      reason: "Evicted",
      message: 'Container check-test exceeded its local ephemeral storage limit "3276Mi". ',
    }),
    NOW,
  );
  assert(overContainer.kind === "checks");
  assertEquals((overContainer.checks.test as Json).exitCode, 1);
  assertEquals((overContainer.checks.lint as Json).exitCode, 0);
});

test("setup that fills its tree past the share is setup_failed with exit 1", () => {
  const read = readCheckJob(
    released(),
    pod({ clone: done(0), "setup-0": done(0), "setup-1": done(137) }, {}, {
      phase: "Failed",
      reason: "Evicted",
      message: 'Usage of EmptyDir volume "pristine" exceeds the limit "3276Mi". ',
    }),
    NOW,
  );
  assertEquals(read, {
    kind: "setup_failed",
    cloneDone: true,
    step: 1,
    exitCode: 1,
    why: "setup step 2 used more disk than its share (3276Mi)",
  });
  // The clone over the share stays the platform's, as every clone failure is.
  const clone = readCheckJob(
    released(),
    pod({ clone: done(137) }, {}, {
      phase: "Failed",
      reason: "Evicted",
      message: 'Usage of EmptyDir volume "pristine" exceeds the limit "3276Mi". ',
    }),
    NOW,
  );
  assert(clone.kind === "setup_failed");
  assertEquals(clone.exitCode, null);
});

test("the pod over its disk total past the clone is the head's, naming no part", () => {
  const overTotal = {
    phase: "Failed",
    reason: "Evicted",
    message: "Pod ephemeral local storage usage exceeds the total limit of containers 10Gi. ",
  };
  const checks = readCheckJob(
    released(),
    pod(SETUP_DONE, {
      "check-lint": done(0),
      "check-test": { state: { running: { startedAt: "2026-09-30T11:58:30Z" } } },
    }, overTotal),
    NOW,
  );
  assert(checks.kind === "checks");
  assertEquals(checks.done, true);
  // What had exited keeps its code; what the eviction cut short failed on the suite's account.
  assertEquals((checks.checks.lint as Json).exitCode, 0);
  assertEquals(checks.checks.test, {
    state: "exited",
    exitCode: 1,
    startedAt: "2026-09-30T11:58:30Z",
    finishedAt: null,
    reason: "the suite's checks together used more disk than the class allows (10Gi)",
  });
  const killed = readCheckJob(
    released(),
    pod(SETUP_DONE, { "check-lint": done(137), "check-test": done(2) }, overTotal),
    NOW,
  );
  assert(killed.kind === "checks");
  assertEquals((killed.checks.lint as Json).exitCode, 1);
  assertEquals((killed.checks.test as Json).exitCode, 2);

  assertEquals(
    readCheckJob(
      released(),
      pod({ clone: done(0), "setup-0": { state: { running: {} } } }, {}, overTotal),
      NOW,
    ),
    {
      kind: "setup_failed",
      cloneDone: true,
      step: 0,
      exitCode: 1,
      why: "setup step 1 took the pod past its disk total (10Gi)",
    },
  );
  // A check's pool directory over its own small limit: that check's failure, saying so.
  const pooled = readCheckJob(
    released(),
    pod(SETUP_DONE, {
      "check-lint": done(0),
      "check-test": { state: { running: { startedAt: "2026-09-30T11:58:30Z" } } },
    }, {
      ...overTotal,
      message: 'Usage of EmptyDir volume "pool-test" exceeds the limit "64Ki". ',
    }),
    NOW,
  );
  assert(pooled.kind === "checks");
  assertEquals((pooled.checks.lint as Json).exitCode, 0);
  assertEquals((pooled.checks.test as Json).exitCode, 1);
  assertEquals(
    (pooled.checks.test as Json).reason,
    "wrote more than 64Ki into its directory of the memory pool",
  );
  // During the clone it stays the platform's.
  const clone = readCheckJob(released(), pod({ clone: done(137) }, {}, overTotal), NOW);
  assert(clone.kind === "setup_failed");
  assertEquals(clone.exitCode, null);
});

test("only an eviction that names a part's own limit is the head's", () => {
  const evicted = (message: string, conditions: Json[] = []): CheckPod =>
    pod(SETUP_DONE, {}, { phase: "Failed", reason: "Evicted", message, conditions });
  // Node pressure names containers too, and is still the platform's.
  assertEquals(
    ownDiskEviction(evicted(
      "The node was low on resource: ephemeral-storage. Threshold quantity: 1Gi, available: 10Mi. " +
        "Container check-test was using 5Gi, request is 3Gi, has larger consumption of " +
        "ephemeral-storage. ",
    )),
    null,
  );
  // The pod over its total names no part, but every part of it is the head's.
  assertEquals(
    ownDiskEviction(
      evicted("Pod ephemeral local storage usage exceeds the total limit of containers 10Gi. "),
    ),
    { pod: true, limit: "10Gi" },
  );
  // A pool directory is written by its own check's container alone: that check's.
  assertEquals(
    ownDiskEviction(evicted('Usage of EmptyDir volume "pool-test" exceeds the limit "64Ki". ')),
    { check: "test", pool: true, limit: "64Ki" },
  );
  // Said on the DisruptionTarget condition instead: the same.
  assertEquals(
    ownDiskEviction(pod(SETUP_DONE, {}, {
      conditions: [{
        type: "DisruptionTarget",
        status: "True",
        reason: "TerminationByKubelet",
        message: 'Usage of EmptyDir volume "work-lint" exceeds the limit "1Gi". ',
      }],
    })),
    { check: "lint", limit: "1Gi" },
  );
  // The pod's own words are never read: a message only counts on an eviction.
  assertEquals(
    ownDiskEviction(pod(SETUP_DONE, {}, {
      phase: "Failed",
      reason: "Error",
      message: 'Usage of EmptyDir volume "work-lint" exceeds the limit "1Gi". ',
    })),
    null,
  );
});

test(
  "a DisruptionTarget pod: what ended after it began is the platform's, what ended before is not",
  () => {
    const preempted = {
      phase: "Running",
      conditions: [{
        type: "DisruptionTarget",
        status: "True",
        reason: "PreemptionByScheduler",
        message: "preempted by a higher-priority pod",
        lastTransitionTime: "2026-09-30T11:30:00Z",
      }],
    };
    const read = readCheckJob(
      released(),
      pod(SETUP_DONE, {
        "check-lint": at("2026-09-30T11:29:00Z", 2),
        "check-test": at("2026-09-30T11:30:05Z", 143),
      }, preempted),
      NOW,
    );
    assert(read.kind === "checks");
    assertEquals((read.checks.lint as Json).exitCode, 2);
    assertEquals((read.checks.test as Json).exitCode, CHECK_PLATFORM_EXIT);
    assertStringIncludes((read.checks.test as Json).reason, "PreemptionByScheduler");

    // Before setup finished: setup_failed with no exit code, naming the cause.
    const inSetup = readCheckJob(
      released(),
      pod({ clone: done(0), "setup-0": at("2026-09-30T11:30:02Z", 137) }, {}, preempted),
      NOW,
    );
    assert(inSetup.kind === "setup_failed");
    assertEquals(inSetup.exitCode, null);
    assertEquals(inSetup.step, 0);
    assertStringIncludes(inSetup.why, "PreemptionByScheduler");
    const stillRunning = readCheckJob(
      released(),
      pod({ clone: { state: { running: {} } } }, {}, preempted),
      NOW,
    );
    assert(stillRunning.kind === "setup_failed");
    assertEquals(stillRunning.step, "clone");
    assertEquals(stillRunning.exitCode, null);
  },
);

test("a container the kubelet lost track of is never the head's failure", () => {
  const read = readCheckJob(
    released(),
    pod(SETUP_DONE, { "check-lint": done(0), "check-test": done(137, "ContainerStatusUnknown") }),
    NOW,
  );
  assert(read.kind === "checks");
  assertEquals((read.checks.test as Json).exitCode, CHECK_PLATFORM_EXIT);
});

test("a plain Failed pod is its checks' doing, not the platform's", () => {
  const read = readCheckJob(
    released(),
    pod(SETUP_DONE, { "check-lint": done(0), "check-test": done(137) }, { phase: "Failed" }),
    NOW,
  );
  assert(read.kind === "checks");
  assertEquals((read.checks.test as Json).exitCode, 137);
});

test(
  "a service the kubelet keeps restarting ends the checks still waiting as the platform's",
  () => {
    const job = (() => {
      const j = checkJobManifest({ ...SPEC, services: [DB] }, OPTS, SECRET);
      return {
        ...j,
        metadata: { ...j.metadata, uid: "u", creationTimestamp: ago(60_000) },
        spec: { ...j.spec, suspend: false },
      };
    })();
    const svc = (restartCount: number) => ({
      restartCount,
      state: { waiting: { reason: "CrashLoopBackOff" } },
    });
    const running = { state: { running: {} } };
    const once = readCheckJob(
      job,
      pod({ ...SETUP_DONE, "svc-postgres": svc(1) }, {
        "check-lint": done(0),
        "check-test": running,
      }),
      NOW,
    );
    assert(once.kind === "checks");
    assertEquals(once.done, false);
    const crashing = readCheckJob(
      job,
      pod({ ...SETUP_DONE, "svc-postgres": svc(SERVICE_RESTART_LIMIT) }, {
        "check-lint": done(0),
        "check-test": running,
      }),
      NOW,
    );
    assert(crashing.kind === "checks");
    assertEquals(crashing.done, true);
    assertEquals((crashing.checks.lint as Json).exitCode, 0);
    assertEquals((crashing.checks.test as Json).exitCode, CHECK_PLATFORM_EXIT);
    assertStringIncludes((crashing.checks.test as Json).reason, "service postgres keeps failing");
  },
);

test(
  "a finished Job with no pod is lost; a Job never released is stale after its grace",
  () => {
    const complete = { conditions: [{ type: "Complete", status: "True" }] };
    assertEquals(readCheckJob(released(complete), null, NOW), { kind: "lost" });
    const suspended = checkJobManifest(SPEC, OPTS, SECRET);
    suspended.metadata.creationTimestamp = ago(SUSPENDED_GRACE_MS + 1);
    assertEquals(readCheckJob(suspended, null, NOW), { kind: "stale" });
    suspended.metadata.creationTimestamp = ago(1000);
    assertEquals(readCheckJob(suspended, null, NOW).kind, "pending");
  },
);

// ── against a fake API server ───────────────────────────────────────────────────────────────────

interface Recorded {
  method: string;
  path: string;
  body: Json;
}

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
    const text = reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return Promise.resolve(new Response(text, { status: reply.status }));
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const JOBS = "/apis/batch/v1/namespaces/ryph-runs/jobs";
const notFound = { status: 404, body: { kind: "Status", message: "not found" } };

test("launch creates the Job suspended, then its owned Secret, then releases it", async () => {
  const api = fakeApi((req) => {
    if (req.method === "POST" && req.path === JOBS) {
      return { status: 201, body: { ...req.body, metadata: { ...req.body.metadata, uid: "u-9" } } };
    }
    if (req.method === "POST") return { status: 201, body: req.body };
    return undefined;
  });
  await kubernetesCheckLauncher(OPTS, silentDiagnostics(), { fetch: api.fetch }).launch(SPEC);
  assertEquals(api.requests.map((r) => `${r.method} ${r.path}`), [
    `POST ${JOBS}`,
    "POST /api/v1/namespaces/ryph-runs/secrets",
    `PATCH ${JOBS}/${SPEC.name}`,
  ]);
  const secret = api.requests[1].body;
  assertEquals(secret.metadata.ownerReferences[0].uid, "u-9");
  // The Secret the Job references is the Secret written.
  const clone = api.requests[0].body.spec.template.spec.initContainers[0];
  const ref = clone.env.find((e: Json) => e.name === "GIT_CONFIG_VALUE_0");
  assertEquals(ref.valueFrom.secretKeyRef.name, secret.metadata.name);
  assert(secret.metadata.name.startsWith(`${SPEC.name}-`));
  // The uid holds the release to the Job this launch created.
  assertEquals(api.requests[2].body, { metadata: { uid: "u-9" }, spec: { suspend: false } });
});

test(
  "launching a released record again is success; a half-launched one goes and throws",
  async () => {
    const conflict = { status: 409, body: { message: "already exists" } };
    const running = fakeApi((req) => {
      if (req.method === "POST") return conflict;
      if (req.method === "GET") return { status: 200, body: released() };
      return undefined;
    });
    await kubernetesCheckLauncher(OPTS, silentDiagnostics(), { fetch: running.fetch }).launch(SPEC);
    assertEquals(running.requests.map((r) => r.method), ["POST", "GET"]);

    const suspended = checkJobManifest(SPEC, OPTS, SECRET);
    suspended.metadata.uid = "u-half";
    const half = fakeApi((req) => {
      if (req.method === "POST") return conflict;
      if (req.method === "GET") return { status: 200, body: suspended };
      return undefined;
    });
    await assertRejects(
      () => kubernetesCheckLauncher(OPTS, silentDiagnostics(), { fetch: half.fetch }).launch(SPEC),
      Error,
      "half-launched",
    );
    assertEquals(half.requests.at(-1)?.method, "DELETE");
    assertEquals(half.requests.at(-1)?.body.preconditions, { uid: "u-half" });
  },
);

test("a launch that fails after the Job exists deletes the Job", async () => {
  const api = fakeApi((req) => {
    if (req.method === "POST" && req.path === JOBS) {
      return { status: 201, body: { ...req.body, metadata: { ...req.body.metadata, uid: "u" } } };
    }
    if (req.method === "POST") return { status: 403, body: { message: "forbidden" } };
    return undefined;
  });
  await assertRejects(() =>
    kubernetesCheckLauncher(OPTS, silentDiagnostics(), { fetch: api.fetch }).launch(SPEC)
  );
  assertEquals(
    api.requests.at(-1)?.path,
    `${JOBS}/${SPEC.name}?propagationPolicy=Background`,
  );
  // Only the Job it created: a successor under the same name is not its to delete.
  assertEquals(api.requests.at(-1)?.body.preconditions, { uid: "u" });
});

test("a slow cleanup that finds a successor under the name leaves it be", async () => {
  const api = fakeApi((req) => {
    if (req.method === "POST" && req.path === JOBS) {
      return { status: 201, body: { ...req.body, metadata: { ...req.body.metadata, uid: "old" } } };
    }
    if (req.method === "POST") return { status: 500, body: { message: "etcd" } };
    // The API server's answer to a uid precondition another Job fails.
    if (req.method === "DELETE") {
      return { status: 409, body: { message: "Precondition failed: UID in precondition: old" } };
    }
    return undefined;
  });
  const warned: string[] = [];
  const diag = { ...silentDiagnostics(), warn: (event: string) => void warned.push(event) };
  await assertRejects(
    () => kubernetesCheckLauncher(OPTS, diag, { fetch: api.fetch }).launch(SPEC),
    Error,
    "etcd",
  );
  assertEquals(api.requests.at(-1)?.method, "DELETE");
  assertEquals(warned, []);
});

test("services on a cluster without native sidecars are refused before any Job", async () => {
  const api = fakeApi((req) =>
    req.path === "/version" ? { status: 200, body: { major: "1", minor: "28" } } : undefined
  );
  await assertRejects(
    () =>
      kubernetesCheckLauncher(OPTS, silentDiagnostics(), { fetch: api.fetch }).launch({
        ...SPEC,
        services: [DB],
      }),
    Error,
    "native sidecars",
  );
  assertEquals(api.requests.map((r) => r.path), ["/version"]);
});

test("poll reads the Job and its pod by name — any replica can", async () => {
  const api = fakeApi((req) => {
    if (req.path === `${JOBS}/${SPEC.name}`) return { status: 200, body: released() };
    if (req.path.startsWith("/api/v1/namespaces/ryph-runs/pods?labelSelector=")) {
      // By the Job's uid: a relaunch reuses the name, never the uid.
      assertStringIncludes(
        req.path,
        encodeURIComponent("batch.kubernetes.io/controller-uid=job-uid-2"),
      );
      return {
        status: 200,
        body: { items: [pod(SETUP_DONE, { "check-lint": done(0), "check-test": done(0) })] },
      };
    }
    return undefined;
  });
  const launcher = kubernetesCheckLauncher(OPTS, silentDiagnostics(), {
    fetch: api.fetch,
    now: () => NOW,
  });
  const read = await launcher.poll(SPEC.name);
  assert(read.kind === "checks" && read.done);
});

test("poll: 404 is gone, anything else unknown; a lost Job is deleted and gone", async () => {
  const missing = fakeApi(() => notFound);
  assertEquals(
    await kubernetesCheckLauncher(OPTS, silentDiagnostics(), { fetch: missing.fetch }).poll("x"),
    { kind: "gone" },
  );
  const broken = fakeApi(() => ({ status: 500, body: { message: "etcd" } }));
  const unknown = await kubernetesCheckLauncher(OPTS, silentDiagnostics(), {
    fetch: broken.fetch,
  }).poll("x");
  assertEquals(unknown.kind, "unknown");

  const lost = fakeApi((req) => {
    if (req.path === `${JOBS}/${SPEC.name}`) {
      return {
        status: 200,
        body: released({ conditions: [{ type: "Complete", status: "True" }] }),
      };
    }
    if (req.path.includes("/pods?")) return { status: 200, body: { items: [] } };
    return undefined;
  });
  const gone = await kubernetesCheckLauncher(OPTS, silentDiagnostics(), {
    fetch: lost.fetch,
    now: () => NOW,
  }).poll(SPEC.name);
  assertEquals(gone, { kind: "gone" });
  assertEquals(lost.requests.at(-1)?.method, "DELETE");
  assertEquals(lost.requests.at(-1)?.body.preconditions, { uid: "job-uid-2" });
});

test("logs are one container's, cut to the last bytes on a line boundary", async () => {
  const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const api = fakeApi((req) => {
    if (req.path === `${JOBS}/${SPEC.name}`) return { status: 200, body: released() };
    if (req.path.includes("/pods?")) return { status: 200, body: { items: [pod(SETUP_DONE)] } };
    if (req.path.includes("/pods/p-1/log?container=check-test")) return { status: 200, text: log };
    return undefined;
  });
  const launcher = kubernetesCheckLauncher(OPTS, silentDiagnostics(), { fetch: api.fetch });
  const tail = await launcher.logs(SPEC.name, "check-test", 30);
  assertEquals(tail, "line 97\nline 98\nline 99\n");
  const none = fakeApi((req) =>
    req.path === `${JOBS}/${SPEC.name}`
      ? { status: 200, body: released() }
      : req.path.includes("/pods?")
      ? { status: 200, body: { items: [] } }
      : undefined
  );
  assertEquals(
    await kubernetesCheckLauncher(OPTS, silentDiagnostics(), { fetch: none.fetch }).logs(
      SPEC.name,
      "clone",
      100,
    ),
    null,
  );
});

test(
  "a log window over the byte limit is asked again, narrower, so its end survives",
  async () => {
    const LIMIT = 16 * 2 ** 20;
    const tails: number[] = [];
    const api = fakeApi((req) => {
      if (req.path === `${JOBS}/${SPEC.name}`) return { status: 200, body: released() };
      if (req.path.includes("/pods?")) return { status: 200, body: { items: [pod(SETUP_DONE)] } };
      if (req.path.includes("/log?")) {
        const tail = Number(new URLSearchParams(req.path.split("?")[1]).get("tailLines"));
        tails.push(tail);
        // 1 KiB lines: 16 384 of them fill the limit, which cuts the window from its END.
        const lines = Array.from(
          { length: Math.min(tail, 100_000) },
          (_, i) =>
            `${String(100_000 - Math.min(tail, 100_000) + i).padStart(6, "0")} ${"x".repeat(1016)}`,
        ).join("\n") + "\n";
        return { status: 200, text: lines.slice(0, LIMIT) };
      }
      return undefined;
    });
    const launcher = kubernetesCheckLauncher(OPTS, silentDiagnostics(), { fetch: api.fetch });
    const tail = await launcher.logs(SPEC.name, "check-test", 2048);
    assert(tails.length > 1 && tails.at(-1)! < 16_384, JSON.stringify(tails));
    // The last line of the log, not the last line that fitted in the first window.
    assertStringIncludes(tail!, "099999 ");
  },
);

test("discard deletes the Job in the background, and a missing one is fine", async () => {
  const api = fakeApi(() => notFound);
  await kubernetesCheckLauncher(OPTS, silentDiagnostics(), { fetch: api.fetch }).discard(
    SPEC.name,
  );
  assertEquals(api.requests.map((r) => `${r.method} ${r.path}`), [
    `DELETE ${JOBS}/${SPEC.name}?propagationPolicy=Background`,
  ]);
});

test("list answers every check Job's name, by the component label", async () => {
  const api = fakeApi(() => ({
    status: 200,
    body: { items: [{ metadata: { name: "ryph-check-a-g1" } }, { metadata: { name: "b" } }] },
  }));
  assertEquals(
    await kubernetesCheckLauncher(OPTS, silentDiagnostics(), { fetch: api.fetch }).list(),
    ["ryph-check-a-g1", "b"],
  );
  assertEquals(
    api.requests[0].path,
    `${JOBS}?labelSelector=${encodeURIComponent("app.kubernetes.io/component=check-run")}`,
  );
});
