// The kubernetes provisioner: the Job it writes (the contract with the run's pod, as the argv is
// for docker), the order its launch speaks to the API server in, and what its kills and inspects
// mean. The API server is a fake behind an injected fetch; what it records is what was sent.

import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  BROWSER_CONTAINER,
  browserContainer,
  browserStorageRefusal,
  type JobManifest,
  jobManifest,
  jobState,
  type KubernetesOptions,
  kubernetesOptionsFromEnv,
  kubernetesProvisioner,
  placeholderManifest,
  placeholderName,
  placeholderResources,
  placeholderRungs,
  quantity,
  RESERVE_LEASE,
  RESERVE_RUNGS,
  reservePriorityClass,
  runnerResources,
  secretManifest,
  servicesHeld,
  sidecarContainer,
} from "../src/adapters/provisioner/kubernetes.ts";
import { checkJobManifest } from "../src/adapters/check_launcher/kubernetes.ts";
import type { ServiceRoom } from "../src/core/services.ts";
import { quantityBytes, quantityCores, type RunSize } from "../src/core/run_sizes.ts";
import type { ServiceSpec } from "../src/core/types.ts";
import { makeLease } from "@ryph/service";
import { leaseTimings } from "../src/core/reserved_capacity.ts";
import { fakeClock, recordingDiagnostics, silentDiagnostics, UNSIZED } from "./doubles.ts";

const SPEC = {
  runId: "r-1",
  image: "registry.example/ryph-agent:1",
  size: UNSIZED,
  env: { RYPH_RUN_ID: "r-1", RYPH_RUN_TOKEN: "run-token-secret" },
};

/** A size class carrying only what a test sets. */
const sized = (fields: Partial<RunSize>): RunSize => ({ ...UNSIZED, name: "sized", ...fields });

const OPTS: KubernetesOptions = {
  apiUrl: "https://kube.test",
  namespace: "ryph-runs",
  tokenFile: null,
  caFile: null,
  runUser: { uid: 1994, gid: 1994 },
};

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;

interface Recorded {
  method: string;
  path: string;
  headers: Headers;
  body: Json;
}

/** A fake API server: `answer` decides each reply; every request is recorded in order. */
function fakeApi(answer: (req: Recorded) => { status: number; body?: Json } | undefined) {
  const requests: Recorded[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const req: Recorded = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(req);
    const reply = answer(req) ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
        status: reply.status,
      }),
    );
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const notFound = { status: 404, body: { kind: "Status", message: "not found", code: 404 } };

/** Answers a launch the way a healthy API server does. */
function healthyLaunch(req: Recorded) {
  if (req.method === "POST" && req.path.endsWith("/jobs")) {
    return { status: 201, body: { ...req.body, metadata: { ...req.body.metadata, uid: "u-1" } } };
  }
  if (req.method === "POST") return { status: 201, body: req.body };
  return undefined;
}

test("the Job is suspended, retry-free, and hands the pod no API credential", () => {
  const job = jobManifest(SPEC, OPTS);
  const pod = job.spec.template as Json;
  assertEquals(job.metadata.name, "ryph-run-r-1");
  assertEquals(job.metadata.namespace, "ryph-runs");
  assertEquals(job.spec.suspend, true);
  // A second pod would boot with the same run token and report twice.
  assertEquals(job.spec.backoffLimit, 0);
  assertEquals(pod.spec.restartPolicy, "Never");
  assertEquals(pod.spec.automountServiceAccountToken, false);
  // Named, never the cluster's globalDefault: real work must outrank reserved capacity.
  assertEquals(pod.spec.priorityClassName, "ryph-workload");
  assertEquals(pod.spec.enableServiceLinks, false);
  assertEquals(pod.spec.terminationGracePeriodSeconds, 120);
  assertEquals(pod.metadata.labels["ryph.run"], "r-1");
  assertEquals(pod.metadata.labels["app.kubernetes.io/component"], "agent-run");
  assertEquals(pod.spec.securityContext, { seccompProfile: { type: "RuntimeDefault" } });
  // The runner container meets `restricted` on its own: the uid is given as a number rather than
  // read off the image, because a kubelet can only refuse a number. It sits here and not on the
  // pod, which also carries a task's service containers — vendor images that start as root.
  assertEquals(pod.spec.containers[0].securityContext, {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    runAsNonRoot: true,
    runAsUser: 1994,
    runAsGroup: 1994,
  });
});

test("the run's env never appears in the Job — only a reference to its Secret", () => {
  const job = jobManifest(SPEC, OPTS);
  const container = (job.spec.template as Json).spec.containers[0];
  assertEquals(container.image, SPEC.image);
  assertEquals(container.env, undefined);
  assertEquals(container.envFrom, [{ secretRef: { name: "ryph-run-r-1" } }]);
  // Anyone who can `get jobs` or `get pods` reads this body; the token must not be in it.
  assertEquals(JSON.stringify(job).includes("run-token-secret"), false);
});

test("the Secret carries the env verbatim and is owned by the Job, so it dies with it", () => {
  const secret = secretManifest(SPEC, OPTS, "u-1");
  assertEquals(secret.stringData, SPEC.env);
  assertEquals(secret.metadata.name, "ryph-run-r-1");
  assertEquals(secret.metadata.ownerReferences, [
    { apiVersion: "batch/v1", kind: "Job", name: "ryph-run-r-1", uid: "u-1" },
  ]);
});

test("runtime class, service account, and resources ride the pod only when configured", () => {
  const plain = (jobManifest(SPEC, OPTS).spec.template as Json).spec;
  assertEquals("runtimeClassName" in plain, false);
  assertEquals("serviceAccountName" in plain, false);
  assertEquals("resources" in plain.containers[0], false);

  const tuned = (jobManifest({ ...SPEC, size: sized({ cpu: "2", memory: "4Gi" }) }, {
    ...OPTS,
    runtimeClass: "gvisor",
    serviceAccount: "ryph-run",
    stopGraceSeconds: 300,
  }).spec.template as Json).spec;
  assertEquals(tuned.runtimeClassName, "gvisor");
  assertEquals(tuned.serviceAccountName, "ryph-run");
  assertEquals(tuned.terminationGracePeriodSeconds, 300);
  assertEquals(tuned.containers[0].resources, {
    requests: { cpu: "2", memory: "4Gi" },
    limits: { cpu: "2", memory: "4Gi" },
  });
});

test("a null image is refused, never dropped", () => {
  assertThrows(() => jobManifest({ ...SPEC, image: null }, OPTS), Error, "RYPH_AGENT_IMAGE");
});

test("launch creates the Job suspended, then its Secret, then releases it", async () => {
  const api = fakeApi(healthyLaunch);
  const provisioner = kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: api.fetch });

  const { handle } = await provisioner.launch(SPEC);

  assertEquals(handle, "ryph-runs/ryph-run-r-1");
  assertEquals(api.requests.map((r) => `${r.method} ${r.path}`), [
    "POST /apis/batch/v1/namespaces/ryph-runs/jobs",
    "POST /api/v1/namespaces/ryph-runs/secrets",
    "PATCH /apis/batch/v1/namespaces/ryph-runs/jobs/ryph-run-r-1",
  ]);
  const [createJob, createSecret, release] = api.requests;
  assertEquals(createJob.body.spec.suspend, true);
  // The owner reference carries the uid the API server just assigned, not one we made up.
  assertEquals(createSecret.body.metadata.ownerReferences[0].uid, "u-1");
  assertEquals(release.headers.get("content-type"), "application/merge-patch+json");
  assertEquals(release.body, { spec: { suspend: false } });
});

test("a launch that fails after the Job exists takes the Job down with it", async () => {
  const api = fakeApi((req) => {
    if (req.path.endsWith("/secrets")) {
      return { status: 403, body: { message: 'secrets is forbidden: cannot create "secrets"' } };
    }
    return healthyLaunch(req);
  });
  const provisioner = kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: api.fetch });

  const err = await assertRejects(() => provisioner.launch(SPEC), Error);
  // The API server's own reason surfaces, so the launch-failed event names the missing RBAC.
  assertStringIncludes(String(err), "secrets is forbidden");
  const last = api.requests[api.requests.length - 1];
  assertEquals(
    `${last.method} ${last.path}`,
    "DELETE /apis/batch/v1/namespaces/ryph-runs/jobs/ryph-run-r-1?propagationPolicy=Background",
  );
});

test("the bearer token is re-read on every request, because projected tokens rotate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  const tokenFile = join(dir, "token");
  try {
    await writeFile(tokenFile, "token-one\n");
    const api = fakeApi(() => ({ status: 200, body: { metadata: { name: "x" } } }));
    const provisioner = kubernetesProvisioner(
      { ...OPTS, tokenFile },
      silentDiagnostics(),
      { fetch: api.fetch },
    );
    await provisioner.inspect("ryph-runs/ryph-run-r-1");
    await writeFile(tokenFile, "token-two\n");
    await provisioner.inspect("ryph-runs/ryph-run-r-1");
    assertEquals(api.requests.map((r) => r.headers.get("authorization")), [
      "Bearer token-one",
      "Bearer token-two",
    ]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("no token file, no authorization header — the proxy in front authenticates", async () => {
  const api = fakeApi(() => ({ status: 200, body: { metadata: { name: "x" } } }));
  const provisioner = kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: api.fetch });
  await provisioner.inspect("ryph-runs/ryph-run-r-1");
  assertEquals(api.requests[0].headers.has("authorization"), false);
});

test("a graceful kill deletes the Job and leaves the pod its grace period", async () => {
  const api = fakeApi(() => undefined);
  const provisioner = kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: api.fetch });
  await provisioner.kill("ryph-runs/ryph-run-r-1", { graceful: true });
  assertEquals(api.requests.map((r) => `${r.method} ${r.path}`), [
    "DELETE /apis/batch/v1/namespaces/ryph-runs/jobs/ryph-run-r-1?propagationPolicy=Background",
  ]);
});

test("a hard kill reads the pod, then deletes the Job, then the pod with no grace", async () => {
  const api = fakeApi(() => undefined);
  const provisioner = kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: api.fetch });
  await provisioner.kill("ryph-runs/ryph-run-r-1", { graceful: false });
  // The read comes FIRST and is the whole point of the order: this is the reaper giving up on
  // a run that never reported, and grace 0 is about to take the evidence with it.
  assertEquals(api.requests.map((r) => `${r.method} ${r.path}`), [
    "GET /api/v1/namespaces/ryph-runs/pods?labelSelector=job-name%3Dryph-run-r-1",
    "DELETE /apis/batch/v1/namespaces/ryph-runs/jobs/ryph-run-r-1?propagationPolicy=Background",
    "DELETE /api/v1/namespaces/ryph-runs/pods" +
    "?labelSelector=job-name%3Dryph-run-r-1&gracePeriodSeconds=0",
  ]);
});

test("killing a Job that is already gone succeeds; any other failure surfaces", async () => {
  // The reaper re-issues kills and the TTL controller collects finished Jobs, so a 404 is the
  // outcome the kill wanted. A 403 is a deployment without the RBAC — the reaper must retry it.
  const gone = fakeApi(() => notFound);
  await kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: gone.fetch })
    .kill("ryph-runs/ryph-run-r-1", { graceful: true });

  const forbidden = fakeApi(() => ({ status: 403, body: { message: "jobs is forbidden" } }));
  await assertRejects(
    () =>
      kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: forbidden.fetch })
        .kill("ryph-runs/ryph-run-r-1", { graceful: true }),
    Error,
    "jobs is forbidden",
  );
});

test("the handle's namespace is the one killed, even after the config moved on", async () => {
  const api = fakeApi(() => undefined);
  const provisioner = kubernetesProvisioner(
    { ...OPTS, namespace: "somewhere-else" },
    silentDiagnostics(),
    { fetch: api.fetch },
  );
  await provisioner.kill("ryph-runs/ryph-run-r-1", { graceful: true });
  assertStringIncludes(api.requests[0].path, "/namespaces/ryph-runs/");
});

test("a Job reads as running until a finished condition, or its deletion, says otherwise", () => {
  const job = (status: Json, metadata: Json = {}) =>
    ({ ...jobManifest(SPEC, OPTS), status, metadata: { name: "x", ...metadata } }) as Json;
  assertEquals(jobState(job(undefined)), "running"); // just created, still suspended
  assertEquals(jobState(job({ active: 1 })), "running");
  assertEquals(jobState(job({ conditions: [{ type: "Complete", status: "True" }] })), "exited");
  assertEquals(jobState(job({ conditions: [{ type: "Failed", status: "True" }] })), "exited");
  assertEquals(jobState(job({ conditions: [{ type: "Failed", status: "False" }] })), "running");
  assertEquals(
    jobState(job({ active: 1 }, { deletionTimestamp: "2026-01-01T00:00:00Z" })),
    "exited",
  );
});

test("inspect distinguishes a collected Job from a failing API", async () => {
  const gone = fakeApi(() => notFound);
  assertEquals(
    await kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: gone.fetch })
      .inspect("ryph-runs/ryph-run-r-1"),
    "exited",
  );
  const broken = fakeApi(() => ({ status: 500, body: { message: "etcd timeout" } }));
  assertEquals(
    await kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: broken.fetch })
      .inspect("ryph-runs/ryph-run-r-1"),
    "unknown",
  );
});

// ── configuration ──────────────────────────────────────────────────────────────────────────────

const failing = (message: string): never => {
  throw new Error(message);
};
const envOf = (vars: Record<string, string>) => (name: string) => vars[name];

test("in a pod, the API server, token, CA, and namespace default to the pod's own", async () => {
  const saDir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    await writeFile(`${saDir}/namespace`, "ryph-system\n");
    const opts = kubernetesOptionsFromEnv(
      envOf({ KUBERNETES_SERVICE_HOST: "10.0.0.1", KUBERNETES_SERVICE_PORT: "443" }),
      failing,
      saDir,
    );
    assertEquals(opts.apiUrl, "https://10.0.0.1:443");
    assertEquals(opts.tokenFile, `${saDir}/token`);
    assertEquals(opts.caFile, `${saDir}/ca.crt`);
    assertEquals(opts.namespace, "ryph-system");
  } finally {
    await rm(saDir, { recursive: true });
  }
});

test("an IPv6 API server address is bracketed", () => {
  const opts = kubernetesOptionsFromEnv(
    envOf({ KUBERNETES_SERVICE_HOST: "fd00::1", RYPH_K8S_NAMESPACE: "runs" }),
    failing,
    "/nonexistent",
  );
  assertEquals(opts.apiUrl, "https://[fd00::1]:443");
});

test("an explicit API URL sends no service account token anywhere", () => {
  // Even in a pod: the mounted token is for the API server alone, never for a URL from config.
  const opts = kubernetesOptionsFromEnv(
    envOf({
      KUBERNETES_SERVICE_HOST: "10.0.0.1",
      RYPH_K8S_API_URL: "http://127.0.0.1:8001",
      RYPH_K8S_NAMESPACE: "runs",
    }),
    failing,
    "/nonexistent",
  );
  assertEquals(opts.apiUrl, "http://127.0.0.1:8001");
  assertEquals(opts.tokenFile, null);
  assertEquals(opts.caFile, null);
});

test("the work volume's storage class is read, and resources are no longer this adapter's", () => {
  const base = { RYPH_K8S_API_URL: "http://127.0.0.1:8001", RYPH_K8S_NAMESPACE: "runs" };
  assertEquals(
    kubernetesOptionsFromEnv(envOf(base), failing, "/nonexistent").workVolumeClass,
    undefined,
  );
  const opts = kubernetesOptionsFromEnv(
    // A hard cut: RYPH_K8S_RESOURCES is size classes now (RYPH_RUN_SIZES), read by the core and
    // handed over per run. Set here, it changes nothing.
    envOf({
      ...base,
      RYPH_K8S_WORK_VOLUME_CLASS: "standard-rwo",
      RYPH_K8S_RESOURCES: "cpu=2",
    }),
    failing,
    "/nonexistent",
  );
  assertEquals(opts.workVolumeClass, "standard-rwo");
  assertEquals("resources" in opts, false);
});

test("the runner's uid defaults to the agent images' runner, and root is refused", () => {
  const base = { RYPH_K8S_API_URL: "http://127.0.0.1:8001", RYPH_K8S_NAMESPACE: "runs" };
  assertEquals(
    kubernetesOptionsFromEnv(envOf(base), failing, "/nonexistent").runUser,
    { uid: 1994, gid: 1994 },
  );
  assertEquals(
    kubernetesOptionsFromEnv(
      envOf({ ...base, RYPH_K8S_RUN_USER: "1000:1000" }),
      failing,
      "/nonexistent",
    ).runUser,
    { uid: 1000, gid: 1000 },
  );
  // Zero is root, which is the whole point of pinning a uid; so is anything that is not a pair.
  for (const bad of ["0:0", "1994:0", "1994", "runner:runner", "1994:1994:1994", "-1:1"]) {
    assertThrows(
      () =>
        kubernetesOptionsFromEnv(
          envOf({ ...base, RYPH_K8S_RUN_USER: bad }),
          failing,
          "/nonexistent",
        ),
      Error,
      "RYPH_K8S_RUN_USER",
    );
  }
});

test("outside a pod, with no API URL and no namespace, it fails naming what is missing", () => {
  assertThrows(
    () => kubernetesOptionsFromEnv(envOf({}), failing, "/nonexistent"),
    Error,
    "RYPH_K8S_API_URL",
  );
  assertThrows(
    () =>
      kubernetesOptionsFromEnv(
        envOf({ RYPH_K8S_API_URL: "http://127.0.0.1:8001" }),
        failing,
        "/nonexistent",
      ),
    Error,
    "RYPH_K8S_NAMESPACE",
  );
});

// ---------------------------------------------------------------------------
// Service containers, as native sidecars.
// ---------------------------------------------------------------------------

const DB: ServiceSpec = {
  name: "db",
  image: `postgres:18@sha256:${"a".repeat(64)}`,
  command: ["postgres", "-p", "5433"],
  env: { POSTGRES_PASSWORD: "password" },
  port: 5433,
  security: { capabilities: ["CHOWN", "SETGID", "SETUID"], allowPrivilegeEscalation: false },
  resources: { cpus: "1", memory: "512m" },
};

const podOf = (job: JobManifest) => (job.spec.template as { spec: Record<string, unknown> }).spec;

test("a service becomes a RESTARTABLE init container — the only shape a Job can finish", () => {
  // Plain extra entries under `containers:` would leave every run's pod running forever,
  // because a Job only completes when all of its regular containers exit.
  const pod = podOf(jobManifest({ ...SPEC, services: [DB] }, OPTS));
  const sidecars = pod.initContainers as Array<Record<string, unknown>>;
  assertEquals(sidecars.length, 1);
  assertEquals(sidecars[0].name, "svc-db");
  assertEquals(sidecars[0].restartPolicy, "Always");
  assertEquals(pod.containers !== undefined, true);
});

test("the declaration becomes args, so the image's entrypoint still runs", () => {
  // Kubernetes `command` overrides ENTRYPOINT and `args` overrides CMD; docker's trailing argv
  // overrides CMD alone. Writing the declaration to `command` would run `postgres -p 5433` as
  // PID 1 with docker-entrypoint.sh skipped — no initdb, no privilege drop — so two lines of
  // YAML would mean different things on the two backends.
  const sidecar = sidecarContainer(DB);
  assertEquals(sidecar.args, ["postgres", "-p", "5433"]);
  assertEquals(sidecar.command, undefined);
});

test("the sidecar gets the catalogue's capabilities on top of ALL dropped", () => {
  const sidecar = sidecarContainer(DB);
  // Never the runtime default, which includes CAP_NET_RAW — in this pod's network namespace,
  // where every hop is plaintext HTTP carrying the run token. See the adapter header.
  assertEquals(sidecar.securityContext, {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"], add: ["CHOWN", "SETGID", "SETUID"] },
  });
  // An entry that needs nothing gets nothing added, not an empty `add` key.
  assertEquals(
    sidecarContainer({ ...DB, security: { capabilities: [], allowPrivilegeEscalation: false } })
      .securityContext,
    { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
  );
});

test("the startup gate is a TCP probe on the declared port, bounded under the reaper", () => {
  const sidecar = sidecarContainer(DB);
  assertEquals(sidecar.startupProbe, {
    tcpSocket: { port: 5433 },
    periodSeconds: 2,
    failureThreshold: 90,
  });
  // 180s, comfortably inside the reaper's 600s startup grace: a merely slow database is
  // waited for, and a broken one is still the reaper's to end.
  assertEquals(2 * 90 < 600, true);
});

test("docker's memory spelling becomes a real quantity, not 512 millibytes", () => {
  assertEquals(quantity("512m"), "512Mi");
  assertEquals(quantity("2g"), "2Gi");
  assertThrows(() => quantity("1Gi"), Error);
  const sidecar = sidecarContainer(DB);
  // Request AND limit, and the storage explicit: Autopilot injects 1Gi into a container that
  // asks for none, and an injected quantity is one the runner's share cannot account for.
  assertEquals(sidecar.resources, {
    requests: { cpu: "1", memory: "512Mi", "ephemeral-storage": "1Gi" },
    limits: { cpu: "1", memory: "512Mi", "ephemeral-storage": "1Gi" },
  });
});

const BUDGET = sized({ cpu: "1", memory: "2Gi", ephemeralStorage: "10Gi" });

test("ephemeral storage is the pod's, so the runner keeps what the services leave", () => {
  // The first sidecar run on GKE, verbatim: the runner's 10Gi plus 1Gi per service, refused by
  // Autopilot's admission webhook against its 10Gi pod cap.
  const pod = podOf(jobManifest(
    { ...SPEC, size: BUDGET, services: [DB, { ...DB, name: "redis", port: 6382 }] },
    OPTS,
  ));
  const containers = [
    ...(pod.initContainers as Json[]),
    ...(pod.containers as Json[]),
  ];
  const total = containers
    .map((c) => quantityBytes(c.resources.requests["ephemeral-storage"]))
    .reduce((a, b) => a + b, 0);
  assertEquals(total, quantityBytes("10Gi"));
  // Storage only: CPU and memory are added on top, never taken from the agent.
  assertEquals((pod.containers as Json[])[0].resources.requests, {
    cpu: "1",
    memory: "2Gi",
    "ephemeral-storage": "8Gi",
  });
});

test("a pod budget too small for its services is refused naming the class", () => {
  const err = assertThrows(
    () =>
      jobManifest(
        {
          ...SPEC,
          size: { ...BUDGET, ephemeralStorage: "2Gi" },
          services: [DB, { ...DB, name: "redis", port: 6382 }],
        },
        OPTS,
      ),
    Error,
  );
  assertStringIncludes(err.message, 'size class "sized"');
  assertStringIncludes(err.message, "RYPH_RUN_SIZES");
  assertStringIncludes(err.message, "leaves the runner 0Gi");
});

test("without a storage budget, or without services, the runner's resources stand", () => {
  const cpuOnly = sized({ cpu: "2", memory: "4Gi" });
  assertEquals(
    podOf(jobManifest({ ...SPEC, size: cpuOnly, services: [DB] }, OPTS)).containers,
    podOf(jobManifest({ ...SPEC, size: cpuOnly }, OPTS)).containers,
  );
  assertEquals(
    podOf(jobManifest({ ...SPEC, size: BUDGET, services: [] }, OPTS)).containers,
    podOf(jobManifest({ ...SPEC, size: BUDGET }, OPTS)).containers,
  );
  assertEquals(quantityBytes("512Mi"), 512 * 2 ** 20);
  assertEquals(quantityBytes("1G"), 1e9);
  assertThrows(() => quantityBytes("lots"), Error, "lots");
});

test("every declared name resolves inside the pod, and localhost is not the contract", () => {
  const pod = podOf(jobManifest({
    ...SPEC,
    services: [DB, { ...DB, name: "redis", port: 6382 }],
  }, OPTS));
  assertEquals(pod.hostAliases, [{ ip: "127.0.0.1", hostnames: ["db", "redis"] }]);
});

test("a run with no services produces the manifest it always did", () => {
  // The overwhelmingly common case must not change shape under this feature — in particular
  // the runner container must be byte-identical.
  assertEquals(
    jobManifest({ ...SPEC, services: [] }, OPTS),
    jobManifest(SPEC, OPTS),
  );
  assertEquals(podOf(jobManifest(SPEC, OPTS)).initContainers, undefined);
  assertEquals(podOf(jobManifest(SPEC, OPTS)).hostAliases, undefined);
});

test("the runner container is untouched by the presence of services", () => {
  assertEquals(
    podOf(jobManifest({ ...SPEC, services: [DB] }, OPTS)).containers,
    podOf(jobManifest(SPEC, OPTS)).containers,
  );
});

// ---------------------------------------------------------------------------
// The size class's work volume.

const WORKING = sized({ cpu: "8", memory: "16Gi", ephemeralStorage: "10Gi", workVolume: "50Gi" });

test("a work volume is a generic ephemeral volume at /ryph/work, writable by the run's uid", () => {
  const pod = podOf(
    jobManifest({ ...SPEC, size: WORKING }, { ...OPTS, workVolumeClass: "standard-rwo" }),
  );
  // A PVC that lives and dies with the pod: nothing new for kill or the TTL to clean up.
  assertEquals(pod.volumes, [{
    name: "work",
    ephemeral: {
      volumeClaimTemplate: {
        metadata: {
          labels: {
            "app.kubernetes.io/managed-by": "ryph",
            "app.kubernetes.io/component": "agent-run",
            "ryph.run": "r-1",
          },
        },
        spec: {
          accessModes: ["ReadWriteOnce"],
          storageClassName: "standard-rwo",
          resources: { requests: { storage: "50Gi" } },
        },
      },
    },
  }]);
  const runner = (pod.containers as Json[])[0];
  assertEquals(runner.volumeMounts, [{ name: "work", mountPath: "/ryph/work" }]);
  // A run with nothing baked clones onto the volume too, not onto the capped ephemeral storage.
  assertEquals(runner.env, [{ name: "RUNNER_CHECKOUT_ROOT", value: "/ryph/work" }]);
  // The volume is not ephemeral storage: the runner's requests are the class's, unchanged.
  assertEquals(runner.resources.requests, {
    cpu: "8",
    memory: "16Gi",
    "ephemeral-storage": "10Gi",
  });
  // A new disk is root-owned; fsGroup is what hands it to uid 1994.
  assertEquals(pod.securityContext, {
    seccompProfile: { type: "RuntimeDefault" },
    fsGroup: 1994,
    fsGroupChangePolicy: "OnRootMismatch",
  });
});

test("the volume is seeded from the image's /ryph/work before anything else starts", () => {
  const pod = podOf(jobManifest({ ...SPEC, size: WORKING, services: [DB] }, OPTS));
  const init = pod.initContainers as Json[];
  // FIRST, before the sidecars: nothing may start on a half-copied checkout.
  assertEquals(init.map((c) => c.name), ["seed-work", "svc-db"]);
  const seed = init[0];
  assertEquals(seed.image, SPEC.image);
  // Not a sidecar: it runs to completion, then the rest start.
  assertEquals(seed.restartPolicy, undefined);
  assertEquals(seed.volumeMounts, [{ name: "work", mountPath: "/ryph/work-volume" }]);
  // `cp -a` keeps mtimes (a warm build stays warm), and copies the children, never `.` — whose
  // times and owner on the volume's root uid 1994 may not set.
  assertEquals(seed.command[0], "/bin/bash");
  assertStringIncludes(seed.command[2], 'cp -a "$@" /ryph/work-volume/');
  assertEquals(seed.command[2].includes("/ryph/work/."), false);
  // The runner's confinement, to the letter: same image, same user, same rules.
  assertEquals(seed.securityContext, (pod.containers as Json[])[0].securityContext);
});

test("no work volume means no volume, no seed, and no fsGroup", () => {
  const pod = podOf(jobManifest({ ...SPEC, size: sized({ cpu: "4" }) }, OPTS));
  assertEquals(pod.volumes, undefined);
  assertEquals(pod.initContainers, undefined);
  assertEquals(pod.securityContext, { seccompProfile: { type: "RuntimeDefault" } });
  assertEquals((pod.containers as Json[])[0].volumeMounts, undefined);
  // And unset, the storage class is the cluster's default rather than a guess.
  const claim = (podOf(jobManifest({ ...SPEC, size: WORKING }, OPTS)).volumes as Json[])[0];
  assertEquals("storageClassName" in claim.ephemeral.volumeClaimTemplate.spec, false);
});

test("a cluster too old for sidecars refuses by name, before any Job is created", async () => {
  const calls: string[] = [];
  const provisioner = kubernetesProvisioner(OPTS, silentDiagnostics(), {
    fetch: ((url: string | URL) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === "/version") {
        return Promise.resolve(
          new Response(JSON.stringify({ major: "1", minor: "28" }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch,
  });
  const err = await assertRejects(
    () => provisioner.launch({ ...SPEC, services: [DB] }),
    Error,
  );
  assertStringIncludes(err.message, "1.29 or newer");
  // Refused BEFORE the Job: a manifest whose restartPolicy the kubelet ignores looks like a
  // hung launch, not like a cluster that is too old.
  assertEquals(calls, ["/version"]);
});

test("a hard kill reads the pod's container statuses before deleting them", async () => {
  // The immortal pod: a service whose probe never passes leaves the Job unfinished, the reaper
  // marks the run lost, and the grace-0 delete takes the evidence with it. This is the
  // evidence.
  const { diag, events } = recordingDiagnostics();
  const provisioner = kubernetesProvisioner(OPTS, diag, {
    fetch: ((url: string | URL, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (
        path.startsWith("/api/v1/namespaces/ryph-runs/pods") && (init?.method ?? "GET") === "GET"
      ) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [{
                metadata: { name: "ryph-run-r-1-abcde" },
                status: {
                  phase: "Pending",
                  initContainerStatuses: [{ name: "svc-db", ready: false }],
                },
              }],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch,
  });
  await provisioner.kill("ryph-runs/ryph-run-r-1", { graceful: false });
  const captured = events.find((e) => e.event === "kubernetes.pod_status_at_kill");
  assert(captured !== undefined, "the statuses must be logged before the pod is deleted");
  assertStringIncludes(JSON.stringify(captured.fields), "svc-db");
});

test("the run's wall-clock backstop rides the Job as activeDeadlineSeconds, and only when set", () => {
  const capped = jobManifest({ ...SPEC, deadlineSeconds: 43_920 }, OPTS);
  assertEquals(capped.spec.activeDeadlineSeconds, 43_920);
  const uncapped = jobManifest(SPEC, OPTS);
  assertEquals("activeDeadlineSeconds" in uncapped.spec, false);
});

// ---- reserved capacity ---------------------------------------------------------------------

const STANDARD = sized({
  name: "standard",
  cpu: "4",
  memory: "8Gi",
  ephemeralStorage: "10Gi",
});
const LARGE = sized({
  name: "large",
  cpu: "7",
  memory: "16Gi",
  ephemeralStorage: "10Gi",
  workVolume: "50Gi",
});
const AGENT = "registry.example/ryph-agent:1";

/** The default service policy's room: three services of 1 cpu and 1g each. */
const ROOM: ServiceRoom = { count: 3, cpus: "1", memory: "1g", browser: null };

/** A lease that stays held for the whole of a test pass. */
const HELD = () => true;
/** Services off. */
const NO_ROOM: ServiceRoom = { ...ROOM, count: 0 };

test("a placeholder holds the largest pod its class can ask for, at a priority anything evicts", () => {
  const deployment = placeholderManifest(LARGE, 3, AGENT, ROOM, {
    ...OPTS,
    runtimeClass: "gvisor",
    serviceAccount: "ryph-run",
  }, 1);
  const spec = deployment.spec as Json;
  const pod = spec.template.spec;
  assertEquals(deployment.apiVersion, "apps/v1");
  assertEquals(deployment.metadata.name, "ryph-reserve-large");
  assertEquals(placeholderName("large"), "ryph-reserve-large");
  assertEquals(deployment.metadata.namespace, "ryph-runs");
  assertEquals(spec.replicas, 3);
  // A rolling update would ask for a surge pod, i.e. a node, on every image change.
  assertEquals(spec.strategy, { type: "Recreate" });
  assertEquals(spec.revisionHistoryLimit, 1);
  assertEquals(spec.selector.matchLabels, {
    "app.kubernetes.io/component": "reserved-capacity",
    "ryph.size-class": "large",
  });
  assertEquals(spec.template.metadata.labels, {
    "app.kubernetes.io/managed-by": "ryph",
    "app.kubernetes.io/component": "reserved-capacity",
    "ryph.size-class": "large",
  });
  assertEquals(pod.priorityClassName, "ryph-reserved-capacity-1");
  // The same RuntimeClass as a run is what puts it on the same nodes.
  assertEquals(pod.runtimeClassName, "gvisor");
  assertEquals(pod.serviceAccountName, "ryph-run");
  // The class plus three services, request and limit, in one container. Disk is the class's
  // whatever the count: the sidecars carve theirs out of it. The work volume is not a container
  // resource and is not reserved.
  assertEquals(pod.containers.length, 1);
  assertEquals(pod.containers[0].resources.requests, {
    cpu: "10",
    memory: "19Gi",
    "ephemeral-storage": "10Gi",
  });
  assertEquals(pod.containers[0].resources.limits, pod.containers[0].resources.requests);
  // The agent image, so a reserved node has pulled what every run starts from.
  assertEquals(pod.containers[0].image, AGENT);
  assertEquals(pod.containers[0].command, ["sleep", "infinity"]);
  // Steered like a run, no nodeSelector or tolerations; its only affinity keeps it off any node
  // another placeholder, of any class or cell, already holds.
  assertEquals("nodeSelector" in pod, false);
  assertEquals("tolerations" in pod, false);
  assertEquals(pod.affinity, {
    podAntiAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: [{
        labelSelector: {
          matchLabels: {
            "app.kubernetes.io/managed-by": "ryph",
            "app.kubernetes.io/component": "reserved-capacity",
          },
        },
        namespaceSelector: {},
        topologyKey: "kubernetes.io/hostname",
      }],
    },
  });
});

test("a placeholder holds nothing: no token, no env, no volume, no port, not root", () => {
  const pod = (placeholderManifest(STANDARD, 1, AGENT, ROOM, OPTS, 0).spec as Json).template.spec;
  assertEquals(pod.automountServiceAccountToken, false);
  assertEquals(pod.enableServiceLinks, false);
  assertEquals(pod.terminationGracePeriodSeconds, 0);
  assertEquals(pod.securityContext, {
    runAsNonRoot: true,
    runAsUser: 1994,
    runAsGroup: 1994,
    seccompProfile: { type: "RuntimeDefault" },
  });
  assertEquals(pod.containers.length, 1);
  const container = pod.containers[0];
  assertEquals(container.name, "reserve");
  assertEquals(container.securityContext, {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
  });
  for (const field of ["env", "envFrom", "volumeMounts", "ports", "startupProbe", "args"]) {
    assertEquals(field in container, false, field);
  }
  for (const field of ["volumes", "initContainers", "hostAliases"]) {
    assertEquals(field in pod, false, field);
  }
  // Unset in the options, unset in the pod: the namespace's defaults, as for a run.
  assertEquals("runtimeClassName" in pod, false);
  assertEquals("serviceAccountName" in pod, false);
});

test("a slot of the default class holds the class and three services: 7 cpu, 11Gi", () => {
  assertEquals(placeholderResources(STANDARD, ROOM), {
    cpu: "7",
    memory: "11Gi",
    "ephemeral-storage": "10Gi",
  });
  // Services off: the class alone, spelled as the class spells it.
  assertEquals(placeholderResources(STANDARD, NO_ROOM), runnerResources(STANDARD, 0));
  assertEquals(placeholderResources(STANDARD, NO_ROOM), {
    cpu: "4",
    memory: "8Gi",
    "ephemeral-storage": "10Gi",
  });
  // The room's memory is the largest a service can get, a catalogue floor above the policy
  // included (core/services.ts serviceRoom); a fraction of a core adds up in millicores.
  assertEquals(
    placeholderResources(STANDARD, { count: 3, cpus: "0.5", memory: "2g", browser: null }),
    {
      cpu: "5500m",
      memory: "14Gi",
      "ephemeral-storage": "10Gi",
    },
  );
});

test("a slot holds only as many services as a pod of its class can have", () => {
  // Each sidecar takes 1Gi of the class's disk and the runner keeps at least 1Gi, so a run of a
  // 3Gi class with three services is refused, and no slot need hold room for one.
  const small = sized({ name: "small", cpu: "2", memory: "4Gi", ephemeralStorage: "3Gi" });
  assertEquals(servicesHeld(small, ROOM), 2);
  assertThrows(() => runnerResources(small, 3));
  assertEquals(placeholderResources(small, ROOM), {
    cpu: "4",
    memory: "6Gi",
    "ephemeral-storage": "3Gi",
  });
  assertEquals(servicesHeld(sized({ cpu: "1", ephemeralStorage: "1Gi" }), ROOM), 0);
  assertEquals(servicesHeld(STANDARD, ROOM), 3);
  assertEquals(servicesHeld(STANDARD, NO_ROOM), 0);
  // No disk budget: nothing caps the count, and each sidecar asks for its own disk.
  const diskless = sized({ cpu: "2", memory: "4Gi" });
  assertEquals(servicesHeld(diskless, ROOM), 3);
  assertEquals(placeholderResources(diskless, ROOM), {
    cpu: "5",
    memory: "7Gi",
    "ephemeral-storage": "3Gi",
  });
});

/**
 * What the scheduler reserves for a pod: the larger of its regular containers plus every sidecar,
 * and each init container's own plus the sidecars started before it.
 */
function podRequest(pod: Json): Record<string, number> {
  const amount = (c: Json, field: string) => {
    const value = c.resources?.requests?.[field];
    if (value === undefined) return 0;
    // The API server rounds a cpu finer than a millicore up to one.
    return field === "cpu"
      ? Math.ceil(Number((quantityCores(value) * 1000).toFixed(6)))
      : quantityBytes(value);
  };
  const out: Record<string, number> = {};
  for (const field of ["cpu", "memory", "ephemeral-storage"]) {
    let sidecars = 0;
    let init = 0;
    for (const c of pod.initContainers ?? []) {
      if (c.restartPolicy === "Always") {
        sidecars += amount(c, field);
        init = Math.max(init, sidecars);
      } else {
        init = Math.max(init, sidecars + amount(c, field));
      }
    }
    const regular = (pod.containers as Json[]).reduce((sum, c) => sum + amount(c, field), 0);
    out[field] = Math.max(init, regular + sidecars);
  }
  return out;
}

/** What a check suite of `count` checks on this class, with these services, asks for. */
function checkPodRequest(
  size: RunSize,
  services: ServiceSpec[],
  count: number,
): Record<string, number> {
  const job = checkJobManifest(
    {
      suiteId: "cs-1",
      generation: 1,
      name: "ryph-check-cs-1-g1",
      image: AGENT,
      clone: {
        url: "http://forge.test/repo.git",
        env: {},
        commit: "a".repeat(40),
        baseCommit: "b".repeat(40),
      },
      bakedCheckout: null,
      keep: [],
      setup: [{ run: "npm ci" }],
      checks: Array.from({ length: count }, (_, i) => ({
        name: `c${i}`,
        run: "true",
        timeoutSeconds: 60,
      })),
      services,
      size: { ...size, workVolume: null },
      proxyEnv: {},
      deadlineSeconds: 600,
    },
    OPTS,
    "secret",
  );
  return podRequest((job.spec.template as Json).spec);
}

/** `n` services, each at the most `room` allows. */
function servicesAtMost(room: ServiceRoom, n: number): ServiceSpec[] {
  return Array.from({ length: n }, (_, i): ServiceSpec => ({
    ...DB,
    name: `svc${i}`,
    port: 5433 + i,
    resources: { cpus: room.cpus, memory: room.memory },
  }));
}

function slotRequest(size: RunSize, room: ServiceRoom): Record<string, number> {
  return podRequest({
    containers: [{ resources: { requests: placeholderResources(size, room) } }],
  });
}

function assertFits(pod: Record<string, number>, slot: Record<string, number>, what: string) {
  for (const field of Object.keys(slot)) {
    assert(pod[field] <= slot[field], `${what}: ${field} ${pod[field]} > ${slot[field]}`);
  }
}

test("no run or check pod of the class asks for more than its slot holds", () => {
  const services = servicesAtMost(ROOM, ROOM.count);
  for (const size of [STANDARD, LARGE]) {
    const slot = slotRequest(size, ROOM);
    // A run with every service it may have is exactly the slot.
    const run = podRequest(podOf(jobManifest({ ...SPEC, image: AGENT, size, services }, OPTS)));
    assertEquals(run, slot, size.name);
    // A check suite of the class: init containers run first, checks split the class, sidecars
    // add theirs. One check or several, it never needs more.
    for (const count of [1, 4]) {
      assertFits(checkPodRequest(size, services, count), slot, `${size.name}, ${count} checks`);
    }
  }
});

test("a slot holds the services a one-check suite can carry, one more than a run can", () => {
  // 2560Mi: a run's runner keeps 1Gi, so a run may have one service; a lone check keeps 512Mi,
  // so a one-check suite may have two. The slot holds room for two.
  const odd = sized({ name: "odd", cpu: "2", memory: "4Gi", ephemeralStorage: "2560Mi" });
  assertEquals(servicesHeld(odd, ROOM), 2);
  assertThrows(() => runnerResources(odd, 2));
  assertEquals(placeholderResources(odd, ROOM), {
    cpu: "4",
    memory: "6Gi",
    "ephemeral-storage": "2560Mi",
  });
  const slot = slotRequest(odd, ROOM);
  assertFits(checkPodRequest(odd, servicesAtMost(ROOM, 2), 1), slot, "one check, two services");
  const run = podRequest(
    podOf(
      jobManifest({ ...SPEC, image: AGENT, size: odd, services: servicesAtMost(ROOM, 1) }, OPTS),
    ),
  );
  assertFits(run, slot, "a run, one service");
  // And no more than that: three services leave a lone check under its floor.
  assertThrows(() => checkPodRequest(odd, servicesAtMost(ROOM, 3), 1));
});

test("a slot rounds a cpu finer than a millicore up, as the API server does", () => {
  // The kubelet holds a 0.0004-core sidecar to 1m, so the slot counts it as 1m too.
  const room: ServiceRoom = { count: 1, cpus: "0.0004", memory: "1g", browser: null };
  const half = sized({ name: "half", cpu: "0.5", memory: "1Gi", ephemeralStorage: "2Gi" });
  assertEquals(placeholderResources(half, room).cpu, "501m");
  const run = podRequest(
    podOf(
      jobManifest(
        { ...SPEC, image: AGENT, size: half, services: servicesAtMost(room, 1) },
        OPTS,
      ),
    ),
  );
  assertEquals(run, slotRequest(half, room));
  // A sum of float cores does not round a whole millicore up past itself.
  assertEquals(
    placeholderResources(sized({ name: "x", cpu: "1.1", memory: "1Gi" }), { ...room, cpus: "0.57" })
      .cpu,
    "1670m",
  );
});

test("a slot rounds a fraction of a byte up, as the API server does", () => {
  // 1000.5 bytes is held as 1001 by the API server for the run; the slot's sum must not be a byte
  // short of it.
  const odd = sized({ name: "odd", cpu: "1", memory: "1000.5", ephemeralStorage: "10Gi" });
  assertEquals(placeholderResources(odd, ROOM).memory, String(1001 + 3 * 2 ** 30));
  const run = podRequest(
    podOf(
      jobManifest({ ...SPEC, image: AGENT, size: odd, services: servicesAtMost(ROOM, 3) }, OPTS),
    ),
  );
  assertEquals(run, slotRequest(odd, ROOM));
});

/** A class of `cpu` cores and `memory`, and the 10Gi of disk a reservable class must set. */
const classOf = (name: string, cpu: string | null, memory = "1Gi"): RunSize =>
  sized({ name, cpu, memory, ephemeralStorage: "10Gi" });

test("placeholders take rungs by the cpu they hold, smallest lowest, in any configured order", () => {
  const rungs = placeholderRungs(
    [
      classOf("large", "7", "16Gi"),
      classOf("bare", null),
      classOf("small", "2", "4Gi"),
      classOf("standard", "4", "8Gi"),
    ],
    ROOM,
  );
  // With room for three 1-cpu services: 10, 5 and 7 cpu. A class that reserves nothing has no
  // placeholder, and so no rung.
  assertEquals([...rungs.entries()].sort(), [["large", 6], ["small", 4], ["standard", 5]]);
  assertEquals(reservePriorityClass(0), "ryph-reserved-capacity-0");
  assertEquals(reservePriorityClass(RESERVE_RUNGS - 1), "ryph-reserved-capacity-9");
});

test("a rung is half an octave of cpu on a scale every cell shares", () => {
  const rungOf = (cpu: string) => placeholderRungs([classOf("x", cpu)], NO_ROOM).get("x");
  // Each power of two starts its own rung, exactly; the half-octave between starts the next.
  assertEquals(
    ["1", "1.414", "1.415", "2", "2.828", "2.829", "4", "5.657", "8", "11.314", "16", "22.628"]
      .map((cpu) => rungOf(cpu)),
    [0, 0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  // The bottom and top rungs take everything past them.
  assertEquals([rungOf("100m"), rungOf("64")], [0, 9]);
  // Memory and disk do not move a rung: within a band, classes share one.
  const rungs = placeholderRungs(
    [
      classOf("more-memory", "4", "16Gi"),
      classOf("same", "4", "8Gi"),
      sized({ name: "more-disk", cpu: "4", memory: "8Gi", ephemeralStorage: "20Gi" }),
      classOf("more-cpu", "5", "1Gi"),
    ],
    NO_ROOM,
  );
  assertEquals(new Set(rungs.values()), new Set([4]));
});

test("cells with different classes put the same size on the same rung", () => {
  // Cell A has one 7-cpu class; cell B a 2-cpu and a 32-cpu one. Ranked per cell, A's slot and B's
  // small one would both be rung 0, and a B run could take A's large slot over B's own.
  const a = placeholderRungs([classOf("standard", "7")], NO_ROOM);
  const b = placeholderRungs([classOf("small", "2"), classOf("huge", "32")], NO_ROOM);
  assertEquals([b.get("small"), a.get("standard"), b.get("huge")], [2, 5, 9]);
  assertEquals(
    placeholderRungs([classOf("seven", "7"), classOf("other", "1")], NO_ROOM).get("seven"),
    a.get("standard"),
  );
});

/**
 * The scheduler's preemption, as its documentation states it, over nodes of placeholders: on each
 * node it takes every lower-priority pod off, then gives back as many as still leave room, the
 * highest priority first; of the nodes where the pod then fits, it picks the one whose
 * highest-priority victim is lowest, then the lowest sum of victim priorities, then the fewest
 * victims (then the latest start, which these placeholders tie on).
 */
function preemptFor(
  need: number,
  nodes: Record<
    string,
    { free: number; pods: Array<{ name: string; cpu: number; priority: number }> }
  >,
): { node: string; victims: string[] }[] {
  const options: Array<{ node: string; victims: Array<{ name: string; priority: number }> }> = [];
  for (const [node, { free, pods }] of Object.entries(nodes)) {
    let room = free + pods.reduce((sum, p) => sum + p.cpu, 0);
    if (room < need) continue;
    const victims = [];
    for (const pod of pods.toSorted((a, b) => b.priority - a.priority)) {
      if (room - pod.cpu >= need) room -= pod.cpu;
      else victims.push(pod);
    }
    options.push({ node, victims });
  }
  const highest = (v: Array<{ priority: number }>) => Math.max(...v.map((p) => p.priority));
  const sum = (v: Array<{ priority: number }>) => v.reduce((total, p) => total + p.priority, 0);
  const best = options.toSorted((a, b) =>
    highest(a.victims) - highest(b.victims) || sum(a.victims) - sum(b.victims) ||
    a.victims.length - b.victims.length
  );
  // Every node tied with the best on all three: which one is taken among them is not ours to say.
  return best.filter((o) =>
    highest(o.victims) === highest(best[0].victims) && sum(o.victims) === sum(best[0].victims) &&
    o.victims.length === best[0].victims.length
  ).map((o) => ({ node: o.node, victims: o.victims.map((v) => v.name) }));
}

const placeholderOf = (size: RunSize, rungs: Map<string, number>) => ({
  name: size.name,
  cpu: Number(placeholderResources(size, ROOM).cpu),
  priority: -10 + rungs.get(size.name)!,
});

test("a standard run evicts the standard placeholder and leaves the large slot warm", () => {
  const rungs = placeholderRungs([STANDARD, LARGE], ROOM);
  // One placeholder to a node: an 8-cpu node holding a standard slot, and a 16-cpu one holding a
  // large slot. A standard run (7 cpu with its services) fits on either once its placeholder is
  // gone.
  const nodes = (standard: number, large: number) => ({
    a: { free: 1, pods: [{ ...placeholderOf(STANDARD, rungs), priority: standard }] },
    b: { free: 6, pods: [{ ...placeholderOf(LARGE, rungs), priority: large }] },
  });
  const run = Number(placeholderResources(STANDARD, ROOM).cpu);

  // One priority for every placeholder, as before the ladder: the nodes tie, and the large slot is
  // as likely to go as the standard one.
  assertEquals(preemptFor(run, nodes(-10, -10)).map((o) => o.node), ["a", "b"]);

  // On the ladder: only the standard placeholder is a victim.
  const ladder = preemptFor(
    run,
    nodes(placeholderOf(STANDARD, rungs).priority, placeholderOf(LARGE, rungs).priority),
  );
  assertEquals(ladder, [{ node: "a", victims: ["standard"] }]);
});

test("the ladder needs one placeholder to a node: packed, a large run takes two standard slots", () => {
  const rungs = placeholderRungs([STANDARD, LARGE], ROOM);
  const standard = placeholderOf(STANDARD, rungs);
  const large = placeholderOf(LARGE, rungs);
  const run = large.cpu;

  // Two standard slots binpacked onto one 16-cpu node: its highest victim is the lower rung, so
  // the scheduler empties it and leaves the large slot warm and idle.
  const packed = preemptFor(run, {
    a: {
      free: 2,
      pods: [{ ...standard, name: "standard-1" }, { ...standard, name: "standard-2" }],
    },
    b: { free: 6, pods: [large] },
  });
  assertEquals(packed, [{ node: "a", victims: ["standard-1", "standard-2"] }]);

  // One to a node, as the placeholders' anti-affinity makes them: neither standard node has room
  // for a large run, so it takes its own slot.
  const spread = preemptFor(run, {
    a1: { free: 1, pods: [{ ...standard, name: "standard-1" }] },
    a2: { free: 1, pods: [{ ...standard, name: "standard-2" }] },
    b: { free: 6, pods: [large] },
  });
  assertEquals(spread, [{ node: "b", victims: ["large"] }]);
});

/** An API server holding the given placeholder Deployments, as a list returns them. */
function placeholderApi(
  held: Array<{
    name: string;
    sizeClass: string;
    ready?: number;
    /** Overrides for a Deployment mid-rollout; by default it has caught up and all are updated. */
    updated?: number;
    behind?: boolean;
  }>,
  answer: (req: Recorded) => { status: number; body?: Json } | undefined = () => undefined,
) {
  return fakeApi((req) =>
    answer(req) ?? (req.method === "GET" && req.path.includes("/deployments?")
      ? {
        status: 200,
        body: {
          items: held.map((d) => ({
            metadata: { name: d.name, labels: { "ryph.size-class": d.sizeClass }, generation: 2 },
            ...(d.ready === undefined ? {} : {
              status: {
                readyReplicas: d.ready,
                updatedReplicas: d.updated ?? d.ready,
                observedGeneration: d.behind ? 1 : 2,
              },
            }),
          })),
        },
      }
      : undefined)
  );
}

test("a pass whose lease lapsed lists, then stops before any write", async () => {
  const api = placeholderApi([{ name: "ryph-reserve-gone", sizeClass: "gone" }]);
  const { capacity } = kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: api.fetch });
  const err = await assertRejects(() =>
    capacity!.apply({
      image: AGENT,
      services: ROOM,
      reservations: [{ size: STANDARD, slots: 1 }],
      held: () => false,
    })
  );
  assertStringIncludes(String(err), "stopped before apply standard");
  // The Lease may already be another replica's: neither the apply nor the delete went out.
  assertEquals(api.requests.map((r) => r.method), ["GET"]);
});

test("apply server-side applies each class above zero, then deletes every other placeholder", async () => {
  const api = placeholderApi([
    { name: "ryph-reserve-standard", sizeClass: "standard" },
    { name: "ryph-reserve-large", sizeClass: "large" },
    { name: "ryph-reserve-gone", sizeClass: "gone" },
  ]);
  const { capacity } = kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: api.fetch });
  await capacity!.apply({
    image: AGENT,
    services: ROOM,
    reservations: [{ size: STANDARD, slots: 2 }, { size: LARGE, slots: 0 }],
    held: HELD,
  });

  assertEquals(api.requests.map((r) => `${r.method} ${r.path}`), [
    "GET /apis/apps/v1/namespaces/ryph-runs/deployments?labelSelector=" +
    encodeURIComponent(
      "app.kubernetes.io/managed-by=ryph,app.kubernetes.io/component=reserved-capacity",
    ),
    "PATCH /apis/apps/v1/namespaces/ryph-runs/deployments/ryph-reserve-standard" +
    "?fieldManager=ryph-control-plane&force=true",
    // Large went to zero; `gone` is a class the configuration no longer has.
    "DELETE /apis/apps/v1/namespaces/ryph-runs/deployments/ryph-reserve-large" +
    "?propagationPolicy=Background",
    "DELETE /apis/apps/v1/namespaces/ryph-runs/deployments/ryph-reserve-gone" +
    "?propagationPolicy=Background",
  ]);
  const applied = api.requests[1];
  assertEquals(applied.headers.get("content-type"), "application/apply-patch+yaml");
  // The whole manifest, every time: what makes a second pass, or a new holder's, the same pass.
  // Standard holds 7 cpu with its services: rung 5.
  assertEquals(applied.body, placeholderManifest(STANDARD, 2, AGENT, ROOM, OPTS, 5));
  // No annotations at all: the rollout stamps an earlier version wrote under this same field
  // manager are owned by nobody else, so a forced apply that leaves them out removes them.
  assertEquals("annotations" in applied.body.metadata, false);
});

test("apply deletes a placeholder whose name is not its class's own, even when the class is wanted", async () => {
  const api = placeholderApi([
    { name: "ryph-reserve-standard", sizeClass: "standard" },
    { name: "something-else", sizeClass: "standard" },
  ]);
  const { capacity } = kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: api.fetch });
  await capacity!.apply({
    image: AGENT,
    services: ROOM,
    reservations: [{ size: STANDARD, slots: 1 }],
    held: HELD,
  });
  assertEquals(api.requests.slice(1).map((r) => `${r.method} ${r.path.split("?")[0]}`), [
    "PATCH /apis/apps/v1/namespaces/ryph-runs/deployments/ryph-reserve-standard",
    "DELETE /apis/apps/v1/namespaces/ryph-runs/deployments/something-else",
  ]);
});

const LEASE_PATH = `/apis/coordination.k8s.io/v1/namespaces/ryph-runs/leases`;

/**
 * One Lease, the way the API server keeps it: a create of one that exists is 409 AlreadyExists,
 * an update carrying a resourceVersion other than the current one is 409 Conflict, and every
 * accepted write moves the version. `clock` is every replica's wall clock.
 */
function leaseServer() {
  const state = { lease: null as Json, version: 0 };
  const clock = fakeClock("2026-10-04T12:00:00.000Z");
  const conflict = (reason: string) => ({ status: 409, body: { reason, code: 409 } });
  const answer = (req: Recorded) => {
    if (!req.path.startsWith(LEASE_PATH)) return undefined;
    if (req.method === "GET") {
      return state.lease === null ? notFound : { status: 200, body: state.lease };
    }
    if (req.method === "POST") {
      if (state.lease !== null) return conflict("AlreadyExists");
    } else if (req.method === "PUT") {
      if (state.lease === null) return notFound;
      if (req.body.metadata.resourceVersion !== state.lease.metadata.resourceVersion) {
        return conflict("Conflict");
      }
    } else return undefined;
    state.version++;
    state.lease = {
      ...req.body,
      metadata: { ...req.body.metadata, resourceVersion: String(state.version) },
    };
    return { status: req.method === "POST" ? 201 : 200, body: state.lease };
  };
  /** One replica's reserved capacity Lease against this server, under its own name. */
  const replica = (holder: string) => {
    const api = fakeApi(answer);
    const { capacity } = kubernetesProvisioner(OPTS, silentDiagnostics(), {
      fetch: api.fetch,
      leaseHolder: holder,
    });
    const lease = makeLease({
      store: capacity!.lease,
      identity: capacity!.identity,
      now: clock.now,
      monotonicMs: () => clock.now().getTime(),
      timings: leaseTimings(60_000, 10_000),
      diag: silentDiagnostics(),
    });
    return { lease, requests: api.requests };
  };
  return { state, replica, advance: (seconds: number) => clock.advance(seconds * 1000) };
}

test("the Lease is ryph-reserved-capacity in the runs namespace, held under this process's name", async () => {
  const server = leaseServer();
  const a = server.replica("pod-a-1234");
  await a.lease.tick();
  assertEquals(a.lease.held(), true);
  assertEquals(a.requests.map((r) => `${r.method} ${r.path}`), [
    `GET ${LEASE_PATH}/${RESERVE_LEASE}`,
    `POST ${LEASE_PATH}`,
  ]);
  assertEquals(server.state.lease.metadata, {
    name: "ryph-reserved-capacity",
    namespace: "ryph-runs",
    resourceVersion: "1",
  });
  assertEquals(server.state.lease.spec, {
    holderIdentity: "pod-a-1234",
    leaseDurationSeconds: 180,
    // MicroTime: exactly six fraction digits, or the API server refuses it.
    renewTime: "2026-10-04T12:00:00.000000Z",
    leaseTransitions: 0,
  });
  // Renewed with the version it read: an update that raced another write is refused.
  server.advance(60);
  await a.lease.tick();
  assertEquals(a.requests.at(-1)!.method, "PUT");
  assertEquals(a.requests.at(-1)!.body.metadata.resourceVersion, "1");
  assertEquals(server.state.lease.spec.renewTime, "2026-10-04T12:01:00.000000Z");

  // Unnamed, a process is its pod's name and a nonce: a restarted container is a new holder.
  const { capacity } = kubernetesProvisioner(OPTS, silentDiagnostics(), {});
  assertStringIncludes(capacity!.identity, "-");
  assert(
    capacity!.identity !== kubernetesProvisioner(OPTS, silentDiagnostics(), {}).capacity!.identity,
  );
});

test("an old replica that restarts mid-rollout cannot take the Lease back from the new one", async () => {
  // Old replica O held the Lease, then the new replica N came up and waited; O exited without
  // releasing, and a restart of O mid-rollout must neither take it back nor leave N waiting.
  const server = leaseServer();
  const old = server.replica("old-1");
  const next = server.replica("new-1");
  await old.lease.tick();
  await next.lease.tick();
  assertEquals([old.lease.held(), next.lease.held()], [true, false]);
  // O is killed: no release. N asks once an interval and waits out the hold from when it first
  // saw the Lease, by its own clock.
  server.advance(120);
  await next.lease.tick();
  assertEquals(next.lease.held(), false);
  server.advance(60);
  await next.lease.tick();
  assertEquals(next.lease.held(), true);
  // O restarts later, under a new name (a new process), with the old configuration.
  server.advance(30);
  const restarted = server.replica("old-2");
  await restarted.lease.tick();
  assertEquals(restarted.lease.held(), false);
  // And N keeps it, renewing every pass, for as long as it lives.
  for (let i = 0; i < 5; i++) {
    server.advance(60);
    await next.lease.tick();
    await restarted.lease.tick();
  }
  assertEquals([next.lease.held(), restarted.lease.held()], [true, false]);
  assertEquals(server.state.lease.spec.holderIdentity, "new-1");
});

test("release frees the Lease for the next replica at once", async () => {
  const server = leaseServer();
  const a = server.replica("a");
  const b = server.replica("b");
  await a.lease.tick();
  await b.lease.tick();
  await a.lease.release();
  assertEquals(server.state.lease.spec.holderIdentity, "");
  // Well inside the hold, and b takes it anyway.
  server.advance(1);
  await b.lease.tick();
  assertEquals(b.lease.held(), true);
  assertEquals(server.state.lease.spec.holderIdentity, "b");
});

test("applying the same plan twice sends the same requests, so replicas converge", async () => {
  const api = placeholderApi([{ name: "ryph-reserve-standard", sizeClass: "standard" }]);
  const { capacity } = kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: api.fetch });
  const plan = {
    image: AGENT,
    services: ROOM,
    reservations: [{ size: STANDARD, slots: 1 }],
    held: HELD,
  };
  await capacity!.apply(plan);
  const first = api.requests.splice(0);
  await capacity!.apply(plan);
  assertEquals(api.requests, first);
  // Nothing to delete when only what is wanted is held.
  assertEquals(first.some((r) => r.method === "DELETE"), false);
});

test("a placeholder another replica deleted first is fine; any other failure surfaces", async () => {
  const gone = placeholderApi(
    [{ name: "ryph-reserve-large", sizeClass: "large" }],
    (req) => req.method === "DELETE" ? notFound : undefined,
  );
  await kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: gone.fetch }).capacity!.apply({
    image: AGENT,
    services: ROOM,
    reservations: [{ size: LARGE, slots: 0 }],
    held: HELD,
  });

  const forbidden = placeholderApi(
    [],
    (req) => req.method === "PATCH" ? { status: 403, body: { message: "forbidden" } } : undefined,
  );
  await assertRejects(
    () =>
      kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: forbidden.fetch }).capacity!
        .apply({
          image: AGENT,
          services: ROOM,
          reservations: [{ size: STANDARD, slots: 1 }],
          held: HELD,
        }),
    Error,
    "403",
  );
});

test("one class failing to apply still lets a class set to zero be deleted", async () => {
  const api = placeholderApi(
    [
      { name: "ryph-reserve-standard", sizeClass: "standard" },
      { name: "ryph-reserve-large", sizeClass: "large" },
    ],
    (req) =>
      req.method === "PATCH" && req.path.includes("ryph-reserve-standard")
        ? { status: 422, body: { message: "invalid quantity" } }
        : undefined,
  );
  const { capacity } = kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: api.fetch });
  // The pass still fails, so it is logged and retried, and the message names the class.
  await assertRejects(
    () =>
      capacity!.apply({
        image: AGENT,
        services: ROOM,
        reservations: [{ size: STANDARD, slots: 2 }, { size: LARGE, slots: 0 }],
        held: HELD,
      }),
    Error,
    "apply standard",
  );
  const deletes = api.requests.filter((r) => r.method === "DELETE").map((r) => r.path);
  // Large went to zero and is gone; standard is still wanted, so what it holds stays.
  assertEquals(deletes, [
    "/apis/apps/v1/namespaces/ryph-runs/deployments/ryph-reserve-large" +
    "?propagationPolicy=Background",
  ]);
});

test("status reads only each class's own placeholder, never a stray under another name", async () => {
  const api = placeholderApi([
    { name: "ryph-reserve-standard", sizeClass: "standard", ready: 2 },
    { name: "something-else", sizeClass: "standard", ready: 5 },
    { name: "ryph-reserve-standard", sizeClass: "large", ready: 1 },
  ]);
  const { capacity } = kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: api.fetch });
  assertEquals(await capacity!.status(), [{ sizeClass: "standard", ready: 2 }]);
});

test("status counts only ready placeholders of the current template", async () => {
  const api = placeholderApi([
    // Mid-rollout: two ready pods, but only one of them is on the new template.
    { name: "ryph-reserve-standard", sizeClass: "standard", ready: 2, updated: 1 },
    // The controller has not seen the latest spec yet: nothing it reports is about that spec.
    { name: "ryph-reserve-large", sizeClass: "large", ready: 1, behind: true },
  ]);
  const { capacity } = kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: api.fetch });
  assertEquals(await capacity!.status(), [
    { sizeClass: "standard", ready: 1 },
    { sizeClass: "large", ready: 0 },
  ]);
});

test("status is each placeholder's ready replicas, zero while none are", async () => {
  const api = placeholderApi([
    { name: "ryph-reserve-standard", sizeClass: "standard", ready: 2 },
    { name: "ryph-reserve-large", sizeClass: "large" },
  ]);
  const { capacity } = kubernetesProvisioner(OPTS, silentDiagnostics(), { fetch: api.fetch });
  assertEquals(await capacity!.status(), [
    { sizeClass: "standard", ready: 2 },
    { sizeClass: "large", ready: 0 },
  ]);
});

// --- the browser sidecar ---------------------------------------------------------------------

const BROWSER = {
  image: "registry.example/ryph-browser:1",
  port: 7490,
  resources: { cpu: "1", memory: "1536Mi" },
};

test("the browser is a native sidecar after the services, under the RUNNER's confinement", () => {
  const job = jobManifest(
    { ...SPEC, size: WORKING, services: [DB], browser: BROWSER },
    OPTS,
  );
  const pod = podOf(job);
  const init = pod.initContainers as Array<Record<string, unknown>>;
  // seed-work first, the services, then the browser — last, so a service that never comes up
  // is what the pod is stuck on, not the browser.
  assertEquals(init.map((c) => c.name), ["seed-work", "svc-db", BROWSER_CONTAINER]);
  const browser = init[2];
  assertEquals(browser, {
    name: "browser",
    image: "registry.example/ryph-browser:1",
    restartPolicy: "Always",
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      runAsNonRoot: true,
      runAsUser: 1994,
      runAsGroup: 1994,
    },
    resources: {
      requests: { cpu: "1", memory: "1536Mi", "ephemeral-storage": "1Gi" },
      limits: { cpu: "1", memory: "1536Mi", "ephemeral-storage": "1Gi" },
    },
  });
  // No startupProbe: the runner's own wait decides, so a crash-looping browser never holds the
  // runner back. No env (no runtimeClass here), no Secret, no command: the runner configures it
  // over localhost.
  assertEquals("startupProbe" in browser, false);
  assertEquals("env" in browser || "envFrom" in browser || "args" in browser, false);
  // Its confinement is exactly the runner's, not a catalogue's.
  const runner = (pod.containers as Array<Record<string, unknown>>)[0];
  assertEquals(browser.securityContext, runner.securityContext);
  // It shares the pod's localhost, so no host alias names it.
  assertEquals(
    (pod.hostAliases as Array<{ hostnames: string[] }>)[0].hostnames.includes("browser"),
    false,
  );
});

test("the browser's storage comes out of the runner's share; its cpu and memory go on top", () => {
  const runner = (spec: Parameters<typeof jobManifest>[0]) =>
    (podOf(jobManifest(spec, OPTS)).containers as Array<{ resources: unknown }>)[0].resources;
  // The class alone: the runner has all of it.
  assertEquals(runner({ ...SPEC, size: BUDGET }), {
    requests: { cpu: "1", memory: "2Gi", "ephemeral-storage": "10Gi" },
    limits: { cpu: "1", memory: "2Gi", "ephemeral-storage": "10Gi" },
  });
  // With the browser: 1Gi of storage less, cpu and memory unchanged — the browser's are its own.
  assertEquals(runner({ ...SPEC, size: BUDGET, browser: BROWSER }), {
    requests: { cpu: "1", memory: "2Gi", "ephemeral-storage": "9Gi" },
    limits: { cpu: "1", memory: "2Gi", "ephemeral-storage": "9Gi" },
  });
  // And it counts toward the floor with the services.
  const tight = sized({ cpu: "1", memory: "2Gi", ephemeralStorage: "3Gi" });
  assertEquals(runner({ ...SPEC, size: tight, services: [DB] }) !== undefined, true);
  assertThrows(
    () =>
      jobManifest({
        ...SPEC,
        size: tight,
        services: [DB, { ...DB, name: "db2" }],
        browser: BROWSER,
      }, OPTS),
    Error,
    "the browser",
  );
});

test("no browser means the manifest it always was", () => {
  const without = jobManifest({ ...SPEC, services: [DB] }, OPTS);
  assertEquals(jobManifest({ ...SPEC, services: [DB], browser: null }, OPTS), without);
  // And the container on its own is what the Job embeds.
  assertEquals(
    (podOf(jobManifest({ ...SPEC, browser: BROWSER }, OPTS)).initContainers as unknown[])[0],
    browserContainer(BROWSER, {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      runAsNonRoot: true,
      runAsUser: 1994,
      runAsGroup: 1994,
    }),
  );
});

test("under a runtimeClass the browser's sandbox is required — its one env var", () => {
  const pod = podOf(
    jobManifest({ ...SPEC, browser: BROWSER }, { ...OPTS, runtimeClass: "gvisor" }),
  );
  const browser = (pod.initContainers as Array<Record<string, unknown>>)
    .find((c) => c.name === BROWSER_CONTAINER)!;
  assertEquals(browser.env, [{ name: "RYPH_BROWSER_SANDBOX", value: "required" }]);
  assertEquals("startupProbe" in browser, false);
});

test("a class with no storage left for the browser withholds it rather than failing", () => {
  const tight = sized({ cpu: "1", memory: "2Gi", ephemeralStorage: "2Gi" });
  // One service and the browser would leave the runner nothing, under its 1Gi floor.
  assertStringIncludes(browserStorageRefusal(tight, 1)!, "no ephemeral storage left");
  assertEquals(browserStorageRefusal(tight, 0), null);
  assertEquals(browserStorageRefusal(BUDGET, 3), null);
  // A class the services alone break is the launch's refusal, not the browser's.
  assertEquals(browserStorageRefusal(tight, 5), null);
  // No storage configured at all: nothing to run out of.
  assertEquals(browserStorageRefusal(sized({ cpu: "1", memory: "2Gi" }), 3), null);
});

test("an old cluster withholds the browser: supportsBrowser turns false, the run is told why", async () => {
  const provisioner = kubernetesProvisioner(OPTS, silentDiagnostics(), {
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ major: "1", minor: "28" }), { status: 200 }),
      )) as unknown as typeof fetch,
  });
  // Optimistic until the API server has been asked.
  assertEquals(provisioner.supportsBrowser, true);
  assertStringIncludes((await provisioner.browserRefusal!(BUDGET, 0))!, "native sidecar");
  assertEquals(provisioner.supportsBrowser, false);
});

test("a current cluster takes the browser where the class has room", async () => {
  const provisioner = kubernetesProvisioner(OPTS, silentDiagnostics(), {
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ major: "1", minor: "31+" }), { status: 200 }),
      )) as unknown as typeof fetch,
  });
  assertEquals(await provisioner.browserRefusal!(BUDGET, 0), null);
  assertEquals(provisioner.supportsBrowser, true);
  const tight = sized({ cpu: "1", memory: "2Gi", ephemeralStorage: "2Gi" });
  assertStringIncludes((await provisioner.browserRefusal!(tight, 1))!, "ephemeral storage");
});

test("a browser alone needs sidecars too: an old cluster refuses it by name", async () => {
  const calls: string[] = [];
  const provisioner = kubernetesProvisioner(OPTS, silentDiagnostics(), {
    fetch: ((url: string | URL) => {
      const path = new URL(url).pathname;
      calls.push(path);
      return Promise.resolve(
        new Response(JSON.stringify({ major: "1", minor: "28" }), { status: 200 }),
      );
    }) as unknown as typeof fetch,
  });
  assertEquals(provisioner.supportsBrowser, true);
  const err = await assertRejects(() => provisioner.launch({ ...SPEC, browser: BROWSER }), Error);
  assertStringIncludes(err.message, "a browser");
  assertEquals(calls, ["/version"]);
});

test("a placeholder holds the browser's room on top of the class and its services", () => {
  const withBrowser: ServiceRoom = { ...ROOM, browser: { cpus: "1", memory: "1536Mi" } };
  // 4 + 3 services + 1 browser cores; 8Gi + 3Gi + 1.5Gi.
  assertEquals(placeholderResources(STANDARD, withBrowser), {
    cpu: "8",
    memory: "12800Mi",
    "ephemeral-storage": "10Gi",
  });
  // Services off, browser on: still more than the class alone.
  assertEquals(
    placeholderResources(STANDARD, { ...NO_ROOM, browser: { cpus: "500m", memory: "1Gi" } }),
    {
      cpu: "4500m",
      memory: "9Gi",
      "ephemeral-storage": "10Gi",
    },
  );
});
