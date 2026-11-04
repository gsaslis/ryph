// The Kubernetes ToolHost's manifests — where the isolation promises live on this backend, as the
// argv does on docker (tool_host_argv_test.ts pins those). A tool pod lands in the tools namespace
// and no other, publishes nothing, mounts nothing, holds no API token, and runs non-root,
// read-only, capability-less and memory-capped. The launch SEQUENCE is pinned too: the Secret
// exists before the pod does, or a vendor's container starts without its settings.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  deploymentManifest,
  deploymentState,
  kubernetesToolHost,
  kubernetesToolHostOptionsFromEnv,
  objectName,
  quantity,
  secretManifest,
  serviceManifest,
  TOOL_HOST_PRIORITY_CLASS,
} from "../src/adapters/tool_host/kubernetes.ts";
import { TOOL_USER, TOOLS_NETWORK } from "../src/adapters/tool_host/cli.ts";
import { GUARD_NAME } from "../src/core/hosting.ts";
import type { ToolLaunchSpec } from "../src/ports/tool_host.ts";

const OPTS = { namespace: TOOLS_NETWORK, runtimeClass: "gvisor" };

const SPEC: ToolLaunchSpec = {
  name: `ryph-tool-${"a1".repeat(16)}`,
  image: `grafana/mcp-grafana@sha256:${"a".repeat(64)}`,
  command: ["-t", "streamable-http", "--address", "0.0.0.0:8000", "--disable-write"],
  env: { GRAFANA_URL: "https://grafana.example.com", MCP_GRAFANA_SERVER_TOKEN: "t".repeat(64) },
  port: 8000,
  memory: "512m",
  cpus: "1",
  lifetime: "shared",
};

const GUARD: ToolLaunchSpec = {
  name: GUARD_NAME,
  image: "registry.example.com/ryph-tool-guard:abc123",
  command: [],
  env: { RYPH_TOOL_ROUTES: "" },
  secretEnv: { RYPH_TOOL_GUARD_TOKEN: "t".repeat(64) },
  port: 8080,
  memory: "256m",
  lifetime: "shared",
};

// oxlint-disable-next-line no-explicit-any
const podSpec = (spec: ToolLaunchSpec): any =>
  // oxlint-disable-next-line no-explicit-any
  (deploymentManifest(spec, OPTS).spec as any).template.spec;

test("a tool pod lands in the tools namespace and names no other", () => {
  for (const spec of [SPEC, GUARD]) {
    const manifests = [
      deploymentManifest(spec, OPTS),
      secretManifest(spec, OPTS, "uid-1"),
      serviceManifest(spec, OPTS, "uid-1"),
    ];
    for (const manifest of manifests) {
      assertEquals(manifest.metadata.namespace, TOOLS_NETWORK);
      const text = JSON.stringify(manifest);
      // The services' and the runs' namespaces are the two a hosted vendor container must never
      // be able to name — not as a namespace, not as a selector, not anywhere in the spec.
      // (`ryph` also appears as a label VALUE, which is `managed-by` and not a destination.)
      for (const forbidden of ["ryph-runs", '"namespace":"ryph"', "ryph.svc"]) {
        assert(!text.includes(forbidden), `${forbidden} in ${text}`);
      }
    }
  }
});

test("nothing is published, nothing is mounted, no API token rides along", () => {
  for (const spec of [SPEC, GUARD]) {
    const pod = podSpec(spec);
    assertEquals(pod.automountServiceAccountToken, false);
    assertEquals(pod.enableServiceLinks, false);
    assertEquals(pod.volumes, undefined);
    assertEquals(pod.containers[0].volumeMounts, undefined);
    assertEquals(pod.hostNetwork, undefined);
    // A hostPort is this backend's `-p`: it would put a vendor's server on the node's address,
    // which is exactly what the local adapters refuse for everything but the guard on loopback.
    for (const port of pod.containers[0].ports) assertEquals(port.hostPort, undefined);
    // And the Service in front is cluster-internal: no node port, no load balancer.
    // oxlint-disable-next-line no-explicit-any
    const service = serviceManifest(spec, OPTS, "uid-1").spec as any;
    assertEquals(service.type, "ClusterIP");
    for (const port of service.ports) assertEquals(port.nodePort, undefined);
  }
});

test("non-root, read-only, no capabilities, memory-capped — the docker posture, in fields", () => {
  const [uid, gid] = TOOL_USER.split(":").map(Number);
  for (const spec of [SPEC, GUARD]) {
    const pod = podSpec(spec);
    assertEquals(pod.securityContext.runAsNonRoot, true);
    assertEquals(pod.securityContext.runAsUser, uid);
    assertEquals(pod.securityContext.runAsGroup, gid);
    assertEquals(pod.securityContext.seccompProfile.type, "RuntimeDefault");
    const container = pod.containers[0].securityContext;
    assertEquals(container.allowPrivilegeEscalation, false);
    assertEquals(container.readOnlyRootFilesystem, true);
    assertEquals(container.capabilities, { drop: ["ALL"] });
    assertEquals(container.privileged, undefined);
  }
  assertEquals(podSpec(SPEC).containers[0].resources.limits.memory, "512Mi");
  assertEquals(podSpec(GUARD).containers[0].resources.limits.memory, "256Mi");
});

test("CPU is capped as memory is, declared or not — no vendor container runs uncapped", () => {
  // The launch names one: it is both the request and the ceiling.
  assertEquals(podSpec(SPEC).containers[0].resources, {
    requests: { cpu: "1", memory: "512Mi" },
    limits: { cpu: "1", memory: "512Mi" },
  });
  // The guard's launch names none, and neither may go missing: a request without a limit is a
  // container that can take the whole node anywhere Autopilot is not rewriting limits for us.
  assertEquals(podSpec(GUARD).containers[0].resources, {
    requests: { cpu: "250m", memory: "256Mi" },
    limits: { cpu: "250m", memory: "256Mi" },
  });
});

test("512m is 512 MEBIBYTES here, not 512 millibytes", () => {
  // The trap this function exists for: Kubernetes reads a bare `m` as milli-units, so docker's
  // `512m` would be accepted as half a byte and then never schedule. Every cap crosses through
  // `quantity`, and these are the values the catalogue's MEMORY pattern can produce.
  assertEquals(quantity("512m"), "512Mi");
  assertEquals(quantity("256m"), "256Mi");
  assertEquals(quantity("1g"), "1Gi");
  assertEquals(quantity("4G"), "4Gi");
  assertThrows(() => quantity("512"), Error, "memory cap");
  assertThrows(() => quantity("1t"), Error, "memory cap");
  for (const memory of ["512m", "1g"]) {
    assert(!/^\d+m$/.test(quantity(memory)), `${quantity(memory)} is still a milli-quantity`);
  }
});

test("settings ride a Secret, never the pod spec", () => {
  // `get deployments` is a grant an operator is given freely; a caller token on the spec would
  // ride along with it, and audit logs record pod bodies where they record only a Secret's name.
  const text = JSON.stringify(deploymentManifest(SPEC, OPTS));
  for (const value of Object.values(SPEC.env)) {
    assert(!text.includes(value), `${value.slice(0, 12)}… is on the pod spec`);
  }
  assertEquals(podSpec(SPEC).containers[0].env, undefined);
  assertEquals(podSpec(SPEC).containers[0].envFrom, [{
    secretRef: { name: SPEC.name },
  }]);
  assertEquals(secretManifest(SPEC, OPTS, "uid-1").stringData, SPEC.env);
  // A secretEnv entry lands in the same Secret — the guard's token is one, and a guard without it
  // refuses to start — and stays off the pod spec like everything else.
  const guardText = JSON.stringify(deploymentManifest(GUARD, OPTS));
  assert(!guardText.includes("t".repeat(64)), "the guard token is on the pod spec");
  assertEquals(secretManifest(GUARD, OPTS, "uid-1").stringData, {
    RYPH_TOOL_ROUTES: "",
    RYPH_TOOL_GUARD_TOKEN: "t".repeat(64),
  });
  // And the Secret dies with the Deployment that owns it.
  assertEquals(secretManifest(SPEC, OPTS, "uid-1").metadata.ownerReferences, [
    { apiVersion: "apps/v1", kind: "Deployment", name: SPEC.name, uid: "uid-1" },
  ]);
});

test("the entry's argv appends to the image's entrypoint, and an empty one is omitted", () => {
  // `args` and not `command`: docker appends, and `command` here would REPLACE the entrypoint —
  // a vendor image whose server is its entrypoint would start as whatever the catalogue said.
  assertEquals(podSpec(SPEC).containers[0].args, SPEC.command);
  assertEquals(podSpec(SPEC).containers[0].command, undefined);
  assertEquals(podSpec(GUARD).containers[0].args, undefined);
});

test("vendor pods get the sandbox; the guard, our own build, does not", () => {
  assertEquals(podSpec(SPEC).runtimeClassName, "gvisor");
  assertEquals(podSpec(GUARD).runtimeClassName, undefined);
  assertEquals(
    podSpec({ ...SPEC, name: `ryph-tool-${"b".repeat(32)}` }).runtimeClassName,
    "gvisor",
  );
  // Unset is the node's default runtime, as it is for runs.
  assertEquals(podSpec(SPEC).runtimeClassName, "gvisor");
  const plain = deploymentManifest(SPEC, { namespace: TOOLS_NETWORK });
  // oxlint-disable-next-line no-explicit-any
  assertEquals((plain.spec as any).template.spec.runtimeClassName, undefined);
});

test("every pod, guard included, outranks the placeholders and preempts nothing", () => {
  // ryph-tool-host is `preemptionPolicy: Never`: a server that finds no room waits for a node
  // rather than evicting a run's reserved slot.
  assertEquals(podSpec(SPEC).priorityClassName, TOOL_HOST_PRIORITY_CLASS);
  assertEquals(podSpec(GUARD).priorityClassName, TOOL_HOST_PRIORITY_CLASS);
  assertEquals(TOOL_HOST_PRIORITY_CLASS, "ryph-tool-host");
});

test("one server at a time behind the one address it answers on", () => {
  // oxlint-disable-next-line no-explicit-any
  const spec = deploymentManifest(SPEC, OPTS).spec as any;
  assertEquals(spec.strategy.type, "Recreate");
  // Created scaled to zero — the Secret is written before anything can start without it.
  assertEquals(spec.replicas, 0);
  assertEquals(spec.selector.matchLabels["ryph.tool"], SPEC.name);
});

test("per-run lifetimes and flag-shaped names are refused, as on every backend", () => {
  assertThrows(() => deploymentManifest({ ...SPEC, lifetime: "run" }, OPTS), Error, "per-run");
  assertThrows(() => deploymentManifest({ ...SPEC, name: "--privileged" }, OPTS), Error, "name");
  assertThrows(() => deploymentManifest({ ...SPEC, image: "--privileged" }, OPTS), Error, "image");
});

test("a vendor server is launched under its launch key's name or not at all", () => {
  // The name is the address the guard routes a key to, so no other shape is ever launched — not
  // a pre-launch-key name, not a slug, not a truncation.
  for (
    const name of [
      "ryph-tool-grafana-ms-abc1234567",
      `ryph-tool-${"a".repeat(31)}`,
      `ryph-tool-${"A".repeat(32)}`,
      `ryph-tool-${"a".repeat(33)}`,
      "ryph-tool-guard-elsewhere",
    ]
  ) {
    assertThrows(() => deploymentManifest({ ...SPEC, name }, OPTS), Error, "name", name);
  }
  // Object names are the container's own: nothing is truncated or hashed into shape.
  assertEquals(objectName(SPEC.name), SPEC.name);
  assertEquals(objectName(GUARD_NAME), GUARD_NAME);
  assertThrows(() => objectName("9-leading-digit"), Error, "kubernetes");
  assertThrows(() => objectName(`ryph-tool-${"s".repeat(54)}`), Error, "kubernetes");
});

test("only a ready replica is running: the Service routes to nothing else", () => {
  const of = (status: unknown) =>
    deploymentState(
      {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "x" },
        spec: {},
        status,
      } as Parameters<typeof deploymentState>[0],
    );
  assertEquals(of({ readyReplicas: 1 }), "running");
  assertEquals(of({ readyReplicas: 0 }), "exited");
  assertEquals(of({}), "exited");
  assertEquals(of(undefined), "exited");
});

// ── the adapter against a fake API server ───────────────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  // oxlint-disable-next-line no-explicit-any
  body: any;
}

type Fetch = typeof globalThis.fetch;

function fakeApi(
  handler: (call: Call) => { status?: number; body?: unknown } = () => ({}),
): { calls: Call[]; fetch: Fetch } {
  const calls: Call[] = [];
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    const call: Call = {
      method: init?.method ?? "GET",
      path,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const { status = 200, body = { metadata: { name: "x", uid: "uid-1" } } } = handler(call);
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": typeof body === "string" ? "text/plain" : "application/json" },
      }),
    );
  }) as unknown as Fetch;
  return { calls, fetch: impl };
}

const hostFor = (impl: Fetch, mayAct?: () => boolean) =>
  kubernetesToolHost(
    { apiUrl: "https://api.test", namespace: TOOLS_NETWORK, tokenFile: null, caFile: null },
    { fetch: impl, sleep: () => Promise.resolve(), mayAct },
  );

test("the gateway dials Services, so the guard is never published", () => {
  // hosting.ts only asks for a published port where the host cannot reach a container address.
  // In-cluster it can, which is why no `publish` arm exists anywhere in this adapter.
  assertEquals(hostFor(fakeApi().fetch).reachesGuard, true);
  assertEquals(hostFor(fakeApi().fetch).kind, "kubernetes");
});

test("a launch writes the Secret before the pod can start, and cleans up if it cannot", async () => {
  const { calls, fetch } = fakeApi();
  const launched = await hostFor(fetch).launch(SPEC);
  assertEquals(launched.handle, SPEC.name);
  assertEquals(launched.address, `${SPEC.name}.${TOOLS_NETWORK}.svc:8000`);

  const writes = calls.map((c) => `${c.method} ${c.path.split("?")[0]}`);
  const ns = `/namespaces/${TOOLS_NETWORK}`;
  assertEquals(writes, [
    // Whatever holds the name goes first — the docker adapter's `rm -f`, in three objects.
    `DELETE /apis/apps/v1${ns}/deployments/${SPEC.name}`,
    `DELETE /api/v1${ns}/services/${SPEC.name}`,
    `DELETE /api/v1${ns}/secrets/${SPEC.name}`,
    `POST /apis/apps/v1${ns}/deployments`,
    `POST /api/v1${ns}/secrets`,
    `POST /api/v1${ns}/services`,
    `PATCH /apis/apps/v1${ns}/deployments/${SPEC.name}`,
  ]);
  // Zero at creation, one only after the Secret exists. This ordering is the whole point.
  assertEquals(calls[3].body.spec.replicas, 0);
  assertEquals(calls[6].body, { spec: { replicas: 1 } });
  assertEquals(calls[4].body.stringData, SPEC.env);
});

test("a launch that half-lands takes itself down rather than linger", async () => {
  const { calls, fetch } = fakeApi((call) =>
    call.method === "POST" && call.path.includes("/secrets") ? { status: 403, body: {} } : {}
  );
  await assertRejects(() => hostFor(fetch).launch(SPEC), Error, "403");
  // The three deletes that opened the launch, the Deployment, the failed Secret, then the sweep —
  // of the Deployment this launch created and nothing else, so its dependents go by ownership.
  const deletes = calls.filter((c) => c.method === "DELETE");
  assertEquals(deletes.length, 4);
  assertEquals(deletes[3].body?.preconditions, { uid: "uid-1" });
});

test("a launch sends nothing more once the lease lapses under it, not even its cleanup", async () => {
  // The gateway checked the lease before this launch began, then stalled mid-launch long enough
  // for a successor to take it. Whatever it would have sent next could land on the successor's
  // objects of the same name.
  let holding = true;
  const { calls, fetch } = fakeApi((call) => {
    if (call.method === "POST" && call.path.endsWith("/deployments")) holding = false;
    return {};
  });
  await assertRejects(
    () => hostFor(fetch, () => holding).launch(SPEC),
    Error,
    "no longer holds the hosting lease",
  );
  assertEquals(calls.map((c) => c.method), ["DELETE", "DELETE", "DELETE", "POST"]);
});

test("a stop refused by the lease sends no request at all", async () => {
  const { calls, fetch } = fakeApi();
  await assertRejects(
    () => hostFor(fetch, () => false).stop(SPEC.name),
    Error,
    "no longer holds the hosting lease",
  );
  assertEquals(calls, []);
});

test("stop removes everything the launch made, and a gone one is the outcome wanted", async () => {
  const { calls, fetch } = fakeApi(() => ({ status: 404, body: { message: "not found" } }));
  await hostFor(fetch).stop(SPEC.name);
  assertEquals(calls.map((c) => c.method), ["DELETE", "DELETE", "DELETE"]);
  assert(calls.every((c) => c.path.includes("propagationPolicy=Background")));
});

test("logs come from the newest pod, as text, and never from the env", async () => {
  const { calls, fetch } = fakeApi((call) => {
    if (call.path.includes("/log")) return { body: "line one\nline two\n" };
    if (call.path.includes("/pods")) {
      return {
        body: {
          items: [
            { metadata: { name: "old", creationTimestamp: "2026-09-01T00:00:00Z" } },
            { metadata: { name: "new", creationTimestamp: "2026-09-12T00:00:00Z" } },
          ],
        },
      };
    }
    return {};
  });
  assertEquals(await hostFor(fetch).logs(SPEC.name, 50), "line one\nline two\n");
  const log = calls.at(-1)!.path;
  assert(log.includes("/pods/new/log"), log);
  assert(log.includes("tailLines=50"), log);
});

test("the log read asks for what GKE will serve, not for text/plain", async () => {
  // Measured on GKE 1.35: `Accept: text/plain` on pods/log is a 406 (it negotiates against JSON,
  // YAML and protobuf only), while `*/*` and `application/json` both answer 200 in text/plain.
  const accepts: string[] = [];
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (!path.endsWith("/log")) {
      return Promise.resolve(Response.json({ items: [{ metadata: { name: "p" } }] }));
    }
    const accept = new Headers(init?.headers).get("accept") ?? "";
    accepts.push(accept);
    return Promise.resolve(
      accept.includes("text/plain")
        ? Response.json({ kind: "Status", status: "Failure" }, { status: 406 })
        : new Response("up\n", { headers: { "content-type": "text/plain" } }),
    );
  }) as unknown as Fetch;
  assertEquals(await hostFor(impl).logs(SPEC.name, 10), "up\n");
  assertEquals(accepts.length, 1);
});

test("ensureNetwork creates nothing — it checks the namespace and the grant are there", async () => {
  const { calls, fetch } = fakeApi(() => ({ body: { items: [] } }));
  await hostFor(fetch).ensureNetwork();
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET");
  assert(calls[0].path.startsWith(`/apis/apps/v1/namespaces/${TOOLS_NETWORK}/deployments`));
  // A missing namespace or a missing Role is the reason hosting shows the operator, not a throw
  // swallowed into "hosting is off".
  const denied = fakeApi(() => ({ status: 403, body: { message: "deployments is forbidden" } }));
  await assertRejects(() => hostFor(denied.fetch).ensureNetwork(), Error, "forbidden");
});

test("in a pod the defaults are the pod's own — but never the pod's own namespace", () => {
  const env: Record<string, string> = {
    KUBERNETES_SERVICE_HOST: "10.0.0.1",
    KUBERNETES_SERVICE_PORT: "443",
  };
  const fail = (m: string): never => {
    throw new Error(m);
  };
  const opts = kubernetesToolHostOptionsFromEnv((n) => env[n], fail, "/sa");
  assertEquals(opts.apiUrl, "https://10.0.0.1:443");
  assertEquals(opts.tokenFile, "/sa/token");
  assertEquals(opts.caFile, "/sa/ca.crt");
  // The gateway runs in `ryph`; a vendor's container must not land beside the master key.
  assertEquals(opts.namespace, TOOLS_NETWORK);

  // An API address from config authenticates for us, so no service account token is sent to it.
  env.RYPH_TOOL_HOST_API_URL = "http://127.0.0.1:8001";
  const proxied = kubernetesToolHostOptionsFromEnv((n) => env[n], fail, "/sa");
  assertEquals(proxied.tokenFile, null);
  assertEquals(proxied.caFile, null);

  env.RYPH_TOOL_HOST_API_URL = "not a url";
  assertThrows(() => kubernetesToolHostOptionsFromEnv((n) => env[n], fail, "/sa"), Error, "URL");
});

test("list walks the namespace by our label and hands back object names", async () => {
  const { calls, fetch } = fakeApi((call) => {
    if (call.method === "GET" && call.path.includes("labelSelector=ryph.tool")) {
      return {
        body: {
          items: [
            // One from before launch keys: listed as it is named, so a sweep removes it.
            {
              metadata: {
                name: "ryph-tool-grafana-ms-1",
                labels: { "ryph.tool": "ryph-tool-grafana-ms-1" },
              },
            },
            deploymentManifest(SPEC, { namespace: TOOLS_NETWORK }),
            { metadata: { name: GUARD_NAME, labels: { "ryph.tool": GUARD_NAME } } },
          ],
        },
      };
    }
    return {};
  });
  const names = await hostFor(fetch).list();
  assertEquals(names, ["ryph-tool-grafana-ms-1", SPEC.name, GUARD_NAME]);
  assertEquals(calls.length, 1);
  assert(calls[0].path.startsWith(`/apis/apps/v1/namespaces/${TOOLS_NETWORK}/deployments?`));
});

test("a stop deletes exactly the Deployment this process created, and its dependents go with it", async () => {
  // A gateway whose hosting lease lapsed mid-request must not remove what its successor launched
  // under the same name. The uid precondition is how: a name that has moved on answers 409.
  const { calls, fetch } = fakeApi();
  const host = hostFor(fetch);
  await host.launch(SPEC);
  calls.length = 0;
  await host.stop(SPEC.name);
  assertEquals(calls.map((c) => `${c.method} ${c.path}`), [
    `DELETE /apis/apps/v1/namespaces/${TOOLS_NETWORK}/deployments/${SPEC.name}`,
  ]);
  assertEquals(calls[0].body, {
    apiVersion: "v1",
    kind: "DeleteOptions",
    propagationPolicy: "Background",
    preconditions: { uid: "uid-1" },
  });
});

test("a stop whose name now belongs to someone else's Deployment leaves it alone", async () => {
  const { fetch } = fakeApi((call) =>
    call.method === "DELETE" &&
      (call.body as { preconditions?: unknown } | undefined)?.preconditions
      ? { status: 409, body: { message: "the UID in the precondition does not match" } }
      : {}
  );
  const host = hostFor(fetch);
  await host.launch(SPEC);
  await host.stop(SPEC.name);
});
