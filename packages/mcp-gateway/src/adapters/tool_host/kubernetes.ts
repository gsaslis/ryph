// A Kubernetes `ToolHost`: hosted MCP servers as one Deployment + Service each, in a namespace of
// their own, fronted by the same tool guard the local backends front them with. Spoken to over
// the API server's REST surface with nothing but fetch, for the run provisioner's reason — the
// handful of calls this needs does not justify a client library, and a hand-held request is one
// whose every header can be read here.
//
// WHY THIS IS THE BACKEND THE PORT WAS WAITING FOR. The docker adapter holds a
// container socket, which is root on the machine, and that is why the standalone gateway — the
// one process holding RYPH_MCP_KEY — was never given one. What this adapter holds instead is a
// ServiceAccount token whose Role (deploy/helm/ryph/templates/tools.yaml) grants six verbs in ONE namespace
// and nothing anywhere else: it cannot touch `ryph` or `ryph-runs`, and cannot reach the
// node. On Secrets it may create and delete and not read — which is not a boundary on its own,
// since anything that writes a pod spec can mount a Secret in its own namespace, so the
// guarantee tools.yaml states is about the namespace's contents: no Secret this process did not
// write itself is in it. That is a grant worth making where a socket was not.
//
// THE TOOLS NETWORK IS A NAMESPACE. `ensureNetwork()` creates nothing: the namespace, its
// NetworkPolicies and this adapter's RBAC are declared in the manifests, where an operator reads
// them, and all this does is check that they are there. Creating a namespace needs cluster-scoped
// RBAC — a much larger grant than running in one — and a boundary a process can create is a
// boundary that process can also shape.
//
// What that buys over the local backends: here the network boundary is REAL. Under OrbStack a run
// reaches a tool container by IP (measured), which is why core/hosting.ts mints a caller token per
// launch as a second line. With Dataplane V2 enforcing them, the policies in tools.yaml mean a run
// pod cannot open a socket to the tools namespace at all. The caller token still rides every
// forward — it costs nothing and it is what holds if a policy is ever loosened.
//
// The env does NOT ride the pod spec. It goes into a Secret the Deployment owns, taken with
// `envFrom`, exactly as the run provisioner does it and for the same reason: `get deployments` is
// a grant an operator is given freely, and a hosted server's env carries its caller token. The
// Deployment is created at `replicas: 0`, the Secret is created owned by it (an owner reference
// needs a uid, which exists only once the Deployment does), and only then is it scaled to one —
// the provisioner's suspend trick, so "the Secret exists before the pod does" is a fact rather
// than a likelihood.
//
// ONE PORT INVARIANT BENDS HERE, and it is worth saying out loud. The port asks for "no restart
// policy — the gateway supervises, so a crash is a status and not a silent loop", and a
// Deployment's pod template accepts exactly one restart policy: Always. So a crashing tool server
// IS restarted, by the kubelet, on its own CrashLoopBackOff (up to five minutes — not a hot loop).
// What the port actually wants survives: `readyReplicas` stays zero, so `inspect` reads exited and
// the gateway's probe fails, and the row still reads "unreachable · see logs". The kubelet retries
// underneath a row that tells the truth, which on a platform that reschedules pods is the better
// half of the trade.
//
// Addresses are SERVICE NAMES — `<name>.<namespace>.svc:<port>` — so `reachesGuard` is true
// and the guard is never published. Nothing here listens on a host port at all; there is no host.
// A vendor server's name is its launch key's (`ryph-tool-<32 hex>`, 42 characters: no truncation,
// no hash of our own) and a launch under any other is refused, so the guard's route to a key
// reaches the Service of that launch or nothing.

import { GUARD_NAME } from "../../core/hosting.ts";
import { toolNameProblem } from "../../core/tool_guard.ts";
import type {
  ToolContainerState,
  ToolHost,
  ToolLaunch,
  ToolLaunchSpec,
} from "../../ports/tool_host.ts";
import { checkSpec, TOOL_USER, TOOLS_NETWORK } from "./cli.ts";
import { KubeError, kubernetesApi, type KubernetesApiOptions } from "../kubernetes_api.ts";

/** Where a pod finds its own identity; the in-cluster defaults below read it. */
const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/** The container's name inside every tool pod — what `kubectl logs -c` takes. */
const CONTAINER = "server";

/** `nobody`, as the docker backend spells it, as the two numbers a pod spec wants. */
const [TOOL_UID, TOOL_GID] = TOOL_USER.split(":").map(Number);

/**
 * The CPU a tool container gets when its launch names none — request AND limit, so a vendor's
 * container has a ceiling on every cluster and not only on Autopilot, which forces them equal.
 * `250m` is core/hosting.ts's `0.25` default in a pod spec's spelling; the two move together.
 */
const DEFAULT_CPU = "250m";

/**
 * The PriorityClass every pod here names (deploy/helm/ryph/templates/priorityclasses.yaml): above the
 * control plane's reserved-capacity placeholders, so none holds a tool server back, and
 * `preemptionPolicy: Never`, so a tool server that finds no room waits for a node instead of
 * evicting a run's warm slot.
 */
export const TOOL_HOST_PRIORITY_CLASS = "ryph-tool-host";

/** A Service name is an RFC 1035 label: a letter, then letters, digits and hyphens, ≤ 63. */
const MAX_NAME = 63;

export interface KubernetesToolHostOptions extends KubernetesApiOptions {
  /**
   * The namespace hosted servers land in — the tools network, as Kubernetes spells it. Never the
   * services' or the runs' namespace; a test pins that no manifest names either.
   */
  namespace: string;
  /**
   * The RuntimeClass vendor tool pods get — `gvisor`, a Kata class. The guard does NOT get it:
   * it is our own build and it streams SSE for the length of a session, where a sandboxed
   * network stack is a cost paid on every byte for code that is already ours.
   */
  runtimeClass?: string;
}

export interface KubernetesToolHostDeps {
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** The wait between create retries; injectable so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Whether this process may change what runs RIGHT NOW — the hosting lease's `held`. Checked
   * before every write this adapter sends, not once per launch: a launch is up to a dozen
   * requests, and a gateway that stalls partway through one can resume after its lease lapsed and
   * a successor launched under the same names. Defaults to always, where one gateway is all there is.
   */
  mayAct?: () => boolean;
}

/** What a write refused by `mayAct` throws. */
export const NOT_HOLDING = "this gateway no longer holds the hosting lease, so it sent nothing";

// The manifest shapes this adapter writes and reads, narrowed to the fields it touches.
type Labels = Record<string, string>;
interface ObjectMeta {
  name: string;
  namespace?: string;
  labels?: Labels;
  annotations?: Record<string, string>;
  uid?: string;
  creationTimestamp?: string;
  ownerReferences?: Array<{ apiVersion: string; kind: string; name: string; uid: string }>;
}
export interface DeploymentManifest {
  apiVersion: "apps/v1";
  kind: "Deployment";
  metadata: ObjectMeta;
  spec: Record<string, unknown>;
  status?: { readyReplicas?: number };
}
export interface SecretManifest {
  apiVersion: "v1";
  kind: "Secret";
  metadata: ObjectMeta;
  type: "Opaque";
  stringData: Record<string, string>;
}
export interface ServiceManifest {
  apiVersion: "v1";
  kind: "Service";
  metadata: ObjectMeta;
  spec: Record<string, unknown>;
}

/**
 * The Kubernetes object name for a container name: the name itself, which must be a Service name
 * as it stands — a vendor's launch key name is 42 characters and the guard's fewer. Nothing is
 * truncated or hashed into shape: an object name is an address, and only an injective one is.
 *
 * Exported for the test. Pure.
 */
export function objectName(name: string): string {
  if (name.length > MAX_NAME || !/^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw new Error(
      `not a name kubernetes can give a Service: ${JSON.stringify(name)} ` +
        `(a letter, then letters, digits and hyphens, at most ${MAX_NAME})`,
    );
  }
  return name;
}

/**
 * Docker's memory spelling as a Kubernetes quantity. NOT cosmetic: `512m` in a pod spec is 512
 * MILLIbytes — half a byte — which Kubernetes accepts without complaint and then cannot schedule
 * against. Every memory cap crossing this boundary goes through here.
 *
 * Exported for the test. Pure.
 */
export function quantity(memory: string): string {
  const match = memory.match(/^([1-9][0-9]{0,4})([mg])$/i);
  if (match === null) throw new Error(`not a memory cap this adapter understands: ${memory}`);
  return `${match[1]}${match[2].toLowerCase() === "m" ? "Mi" : "Gi"}`;
}

/** The guard is our own build and the vendor servers are not; only the labels and the sandbox differ. */
const isGuard = (name: string) => name === GUARD_NAME;

function labelsFor(name: string): Labels {
  return {
    "app.kubernetes.io/managed-by": "ryph",
    "app.kubernetes.io/part-of": "ryph",
    // What the NetworkPolicies in tools.yaml select on: the guard takes ingress from the gateway,
    // a tool server takes ingress from the guard, and neither takes any from a run.
    "app.kubernetes.io/component": isGuard(name) ? "tool-guard" : "tool-server",
    "ryph.tool": objectName(name),
  };
}

/**
 * The Deployment one launch creates — at `replicas: 0`; see the header for why. Pure, and
 * exported for the test: this manifest is where the isolation promises live on this backend, as
 * the argv is on docker.
 */
export function deploymentManifest(
  spec: ToolLaunchSpec,
  opts: Pick<KubernetesToolHostOptions, "namespace" | "runtimeClass">,
): DeploymentManifest {
  checkSpec(spec);
  if (!isGuard(spec.name)) {
    const problem = toolNameProblem(spec.name);
    if (problem !== null) throw new Error(problem);
  }
  const name = objectName(spec.name);
  const labels = labelsFor(spec.name);
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: opts.namespace, labels },
    spec: {
      replicas: 0,
      selector: { matchLabels: { "ryph.tool": name } },
      // Replaced, never rolled: the Service in front of this carries one address, and a vendor
      // server holds MCP sessions. Two of them answering it at once is not an upgrade, it is a
      // coin toss — and the gateway supervises, so a gap is a status, which is the intent.
      strategy: { type: "Recreate" },
      template: {
        metadata: { labels },
        spec: {
          // The gateway's own token is the one thing in this namespace worth stealing, and a
          // vendor's container has no business holding an API credential of any kind.
          automountServiceAccountToken: false,
          // Kubernetes otherwise injects an env var per Service in the namespace: every other
          // hosted server's address, handed to a vendor's process beside its settings.
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 10,
          priorityClassName: TOOL_HOST_PRIORITY_CLASS,
          ...(isGuard(spec.name) || !opts.runtimeClass
            ? {}
            : { runtimeClassName: opts.runtimeClass }),
          // Whatever user the image declares, a tool pod runs as `nobody` — the two local
          // backends' `--user`, in the two fields a pod spec spells it with.
          securityContext: {
            runAsNonRoot: true,
            runAsUser: TOOL_UID,
            runAsGroup: TOOL_GID,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [{
            name: CONTAINER,
            image: spec.image,
            // `args`, not `command`: docker's trailing arguments append to the image's
            // entrypoint, and `command` here would replace it. An empty list is omitted rather
            // than sent, which would clear the image's own CMD.
            ...(spec.command.length > 0 ? { args: spec.command } : {}),
            ports: [{ containerPort: spec.port }],
            envFrom: [{ secretRef: { name } }],
            resources: {
              requests: { cpu: spec.cpus ?? DEFAULT_CPU, memory: quantity(spec.memory) },
              // A limit on both, always. Untrusted vendor code with a CPU request and no ceiling
              // saturates whatever node it lands on; Autopilot hides that by rewriting limits to
              // match requests, so it would have bitten only on the local overlay and on any
              // self-managed cluster.
              limits: { cpu: spec.cpus ?? DEFAULT_CPU, memory: quantity(spec.memory) },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
            },
          }],
        },
      },
    },
  };
}

/** The Secret carrying the launch's settings and its caller token, owned by the Deployment. */
export function secretManifest(
  spec: ToolLaunchSpec,
  opts: Pick<KubernetesToolHostOptions, "namespace">,
  deploymentUid: string,
): SecretManifest {
  const name = objectName(spec.name);
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name,
      namespace: opts.namespace,
      labels: labelsFor(spec.name),
      ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name, uid: deploymentUid }],
    },
    type: "Opaque",
    // Both maps land here. On the CLI hosts `secretEnv` is what travels by name instead of as
    // argv; here everything already travels by name, through this Secret, so the split is moot —
    // but a token left out of it is a guard that refuses to start.
    stringData: { ...spec.env, ...spec.secretEnv },
  };
}

/** The stable address the guard dials. A pod's IP moves on every relaunch; this does not. */
export function serviceManifest(
  spec: ToolLaunchSpec,
  opts: Pick<KubernetesToolHostOptions, "namespace">,
  deploymentUid: string,
): ServiceManifest {
  const name = objectName(spec.name);
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name,
      namespace: opts.namespace,
      labels: labelsFor(spec.name),
      ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name, uid: deploymentUid }],
    },
    spec: {
      // ClusterIP, and no `publish` arm anywhere in this file: the gateway is in the cluster, so
      // there is no host to expose anything to. `reachesGuard` is true for that reason.
      type: "ClusterIP",
      selector: { "ryph.tool": name },
      ports: [{ name: "mcp", port: spec.port, targetPort: spec.port, protocol: "TCP" }],
    },
  };
}

/**
 * What a Deployment says about its server, in the port's three words. Exported for the test.
 *
 * A ready replica is the only thing that counts as running: the Service routes to ready pods, so
 * anything else is an address that answers nothing. A Deployment that exists with none — pulling,
 * pending a node, crash-looping — reads `exited`, which is what a boot reconcile wants (relaunch
 * it) and what a stopped container means on docker. Absent, or unreadable, is `unknown`.
 */
export function deploymentState(deployment: DeploymentManifest): ToolContainerState {
  return (deployment.status?.readyReplicas ?? 0) >= 1 ? "running" : "exited";
}

export function kubernetesToolHost(
  opts: KubernetesToolHostOptions,
  deps: KubernetesToolHostDeps = {},
): ToolHost {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const ns = opts.namespace;
  const { call, callText } = kubernetesApi(opts, deps.fetch);
  const mayAct = deps.mayAct ?? (() => true);

  /** Every request that changes what runs goes through here, and is fenced at the moment it is sent. */
  function write(method: string, path: string, body?: unknown, contentType?: string) {
    if (!mayAct()) return Promise.reject(new Error(NOT_HOLDING));
    return call(method, path, body, contentType);
  }

  const deployments = `/apis/apps/v1/namespaces/${ns}/deployments`;
  const services = `/api/v1/namespaces/${ns}/services`;
  const secrets = `/api/v1/namespaces/${ns}/secrets`;
  const pods = `/api/v1/namespaces/${ns}/pods`;

  /**
   * The uid of each Deployment this process created, by object name. `stop` deletes exactly that
   * object: a gateway whose hosting lease lapsed while a request was in flight must not remove what
   * its successor has since launched under the same name (core/lease.ts).
   */
  const ownUids = new Map<string, string>();

  /** Gone already is the outcome every delete here wants. */
  async function remove(path: string): Promise<void> {
    try {
      await write("DELETE", `${path}?propagationPolicy=Background`);
    } catch (err) {
      if (!(err instanceof KubeError && err.status === 404)) throw err;
    }
  }

  /**
   * A `Background` delete removes the object itself before it returns, so the name is free — but
   * a create landing on the same millisecond can still see it. Three tries at a second, then let
   * the failure reach the row: the supervisor's backoff is the real retry.
   */
  async function create(path: string, manifest: unknown): Promise<unknown> {
    for (let attempt = 1;; attempt++) {
      try {
        return await write("POST", path, manifest);
      } catch (err) {
        const conflict = err instanceof KubeError && err.status === 409;
        if (!conflict || attempt === 3) throw err;
        await sleep(1_000);
      }
    }
  }

  /** Everything one launch owns, in the order that leaves nothing behind. */
  async function removeAll(name: string): Promise<void> {
    await remove(`${deployments}/${name}`);
    await remove(`${services}/${name}`);
    await remove(`${secrets}/${name}`);
  }

  /**
   * Exactly the Deployment with this uid. Its Service and Secret are owned by it, so Background
   * propagation takes them too, and a name that has moved on to another Deployment answers 409 and
   * is left alone (both measured on GKE 1.35).
   */
  async function removeOwn(name: string, uid: string): Promise<void> {
    try {
      await write("DELETE", `${deployments}/${name}`, {
        apiVersion: "v1",
        kind: "DeleteOptions",
        propagationPolicy: "Background",
        preconditions: { uid },
      });
    } catch (err) {
      if (!(err instanceof KubeError && (err.status === 404 || err.status === 409))) throw err;
    }
  }

  return {
    kind: "kubernetes",
    // The gateway is a pod in this cluster, so a Service name is an address it can simply dial.
    // Nothing is published, and there is no loopback for a run to come back around through.
    reachesGuard: true,

    async ensureNetwork() {
      // Creates nothing — see the header. This is the check that the namespace, and this
      // process's grant inside it, are actually there: a 404 names the missing namespace and a
      // 403 names the missing Role, and hosting turns either into the reason the operator reads.
      await call("GET", `${deployments}?limit=1`);
    },

    async launch(spec: ToolLaunchSpec): Promise<ToolLaunch> {
      const name = objectName(spec.name);
      const deployment = deploymentManifest(spec, opts);
      ownUids.delete(name);
      await removeAll(name);
      const created = await create(deployments, deployment) as DeploymentManifest;
      const uid = created.metadata.uid;
      try {
        if (!uid) throw new Error(`kubernetes created deployment ${name} but returned no uid`);
        await create(secrets, secretManifest(spec, opts, uid));
        await create(services, serviceManifest(spec, opts, uid));
        await write(
          "PATCH",
          `${deployments}/${name}`,
          { spec: { replicas: 1 } },
          "application/merge-patch+json",
        );
      } catch (err) {
        // A Deployment scaled to zero with no Secret is a server that can never answer; take it
        // down, and its dependents with it, rather than leave it for the next boot to reconcile.
        // By uid, not by name: if this launch failed because the lease lapsed under it, the name
        // may already be a successor's.
        await (uid ? removeOwn(name, uid) : removeAll(name)).catch(() => {});
        throw err;
      }
      ownUids.set(name, uid as string);
      return { handle: spec.name, address: `${name}.${ns}.svc:${spec.port}` };
    },

    async stop(handle) {
      const name = objectName(handle);
      const uid = ownUids.get(name);
      ownUids.delete(name);
      // One this process did not create — left by a previous gateway, found at boot — goes by name,
      // as it always did. Only the lease holder calls this at all (core/hosting.ts).
      if (uid === undefined) {
        await removeAll(name);
        return;
      }
      await removeOwn(name, uid);
    },

    async list() {
      // Every Deployment of ours in the namespace, by the label every launch writes — the one call
      // that walks the backend rather than the rows. An object's name is its container's.
      const selector = encodeURIComponent("ryph.tool");
      const found = await call("GET", `${deployments}?labelSelector=${selector}`) as {
        items?: DeploymentManifest[];
      };
      return (found.items ?? []).map((d) => d.metadata.name);
    },

    async inspect(handle): Promise<ToolContainerState> {
      try {
        const deployment = await call(
          "GET",
          `${deployments}/${objectName(handle)}`,
        ) as DeploymentManifest;
        return deploymentState(deployment);
      } catch {
        return "unknown";
      }
    },

    async address(handle, port) {
      return (await this.inspect(handle)) === "running"
        ? `${objectName(handle)}.${ns}.svc:${port}`
        : null;
    },

    async logs(handle, tail) {
      const name = objectName(handle);
      const selector = encodeURIComponent(`ryph.tool=${name}`);
      const list = await call("GET", `${pods}?labelSelector=${selector}`) as {
        items?: Array<{ metadata: ObjectMeta }>;
      };
      // Newest first: a Recreate rollout leaves the old pod terminating for a moment, and the
      // logs anyone is asking for are the ones from the container running now.
      const newest = (list.items ?? [])
        .slice()
        .sort((a, b) =>
          (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? "")
        )[0];
      if (newest === undefined) return "";
      // stdout and stderr arrive already interleaved by the kubelet, which is what docker's
      // adapter has to reconstruct from timestamps. Nothing to merge, so nothing to sort.
      return await callText(
        `${pods}/${newest.metadata.name}/log?container=${CONTAINER}&tailLines=${tail}`,
      );
    },
  };
}

/**
 * The options, from the gateway's environment. In a pod the defaults are the pod's own: the API
 * server from the env Kubernetes injects, and the token and CA from the mounted service account.
 * `RYPH_TOOL_HOST_API_URL` replaces all of that with an address that authenticates for us — a
 * `kubectl proxy`, typically — and then no token is sent: a service account token is for the API
 * server alone, never for a URL from config.
 *
 * The namespace is NOT the pod's own. A hosted server belongs in the tools namespace, and the
 * gateway runs in `ryph`; defaulting to "wherever this process happens to be" would put a
 * vendor's container beside the master key.
 */
export function kubernetesToolHostOptionsFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
  serviceAccountDir = SERVICE_ACCOUNT_DIR,
): KubernetesToolHostOptions {
  let apiUrl = env("RYPH_TOOL_HOST_API_URL");
  let tokenFile: string | null = null;
  let caFile: string | null = null;
  if (apiUrl === undefined) {
    const host = env("KUBERNETES_SERVICE_HOST") ??
      fail(
        "RYPH_TOOL_HOST=kubernetes outside a pod needs RYPH_TOOL_HOST_API_URL " +
          "(e.g. a `kubectl proxy` address)",
      );
    const port = env("KUBERNETES_SERVICE_PORT") ?? "443";
    apiUrl = `https://${host.includes(":") ? `[${host}]` : host}:${port}`;
    tokenFile = `${serviceAccountDir}/token`;
    caFile = `${serviceAccountDir}/ca.crt`;
  } else if (!URL.canParse(apiUrl)) {
    fail(`RYPH_TOOL_HOST_API_URL must be an absolute URL, got ${JSON.stringify(apiUrl)}`);
  }
  return {
    apiUrl,
    namespace: env("RYPH_TOOL_HOST_NAMESPACE") ?? TOOLS_NETWORK,
    tokenFile,
    caFile,
    runtimeClass: env("RYPH_TOOL_HOST_RUNTIME_CLASS"),
  };
}
