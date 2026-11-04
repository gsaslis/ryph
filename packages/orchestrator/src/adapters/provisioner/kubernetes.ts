// A Kubernetes `Provisioner`: one batch/v1 Job per run, spoken to over the API server's REST
// surface with nothing but fetch. The four calls this needs — create, patch, delete, get — do not
// justify a client library, and a hand-held request is one whose every header can be read here.
//
// The run's env does NOT ride the pod spec. It goes into a Secret the Job owns, and the container
// takes it with `envFrom`. That closes the exposure the docker adapter documents and
// accepts: anyone who can `get pods` in the namespace would otherwise read every launch's bootstrap
// bearer straight off the spec — and, inside its window, redeem it before the runner does — and
// audit logs record pod bodies where they typically record only a Secret's metadata. RBAC can
// hand an operator pods and logs without secrets; it cannot hand them half a pod spec.
//
// Owning the Secret is what cleans it up — the Job's TTL, or a kill, deletes the Job, and the
// garbage collector takes the Secret with it — but an owner reference needs the owner's uid, which
// exists only once the Job does. So the Job is created SUSPENDED, the Secret is created owned by
// it, and only then is the Job released. Creating the Job live and racing the Secret in behind it
// usually wins, and loses into a CreateContainerConfigError on exactly the fast node where it
// matters; the suspend makes the order a fact instead of a likelihood.
//
// What the pod is denied, and why:
// - no service account token (`automountServiceAccountToken: false`). The agent runs
//   model-authored shell; a mounted token is an API credential handed to it. Where the cluster
//   federates service accounts to a cloud (GKE Workload Identity), the run's service account must
//   also be one bound to nothing — the metadata server answers regardless of the mount.
// - no service links (`enableServiceLinks: false`). Kubernetes otherwise injects an env var per
//   Service in the namespace: the topology, handed to the agent, beside the contract env.
// - no retries (`backoffLimit: 0`). A second pod for the same run would boot with the same run
//   token and report twice; retrying is the orchestrator's decision, never the Job controller's.
// - no root, by number (`runAsNonRoot` + `runAsUser`/`runAsGroup`), on the runner container. An
//   image's `USER` is the image's promise and RYPH_AGENT_IMAGE is operator config; a numeric
//   uid is what a kubelet can refuse to start. It goes on the container and not the pod because
//   the pod also holds the service containers a task asks for, which are vendor images that
//   start as root and drop privileges themselves.
//
// The boundary itself is `runtimeClass` — `gvisor` on GKE Sandbox, or a Kata class — for the
// docker adapter's `--runtime` reasons. Unset is the node's default runtime, the shared kernel.
//
// A run's SERVICE CONTAINERS ride the same Job, as native sidecars: entries under
// `initContainers` carrying `restartPolicy: Always`. That is not a style choice — it is the only
// shape under `batch/v1` that lets a Job with helper containers ever reach `Complete`, because
// the kubelet terminates restartable init containers once the regular ones exit. Plain extra
// entries under `containers:` would leave every run's pod running forever, and the Job with it.
//
// What that shape buys, and it is most of the reason this is the backend where the feature is
// real: cleanup is free (deleting the Job cascades — no new orphan class, no sweeper, unlike
// docker), there is no new RBAC (they are containers of a Job this process already creates), and
// the isolation is genuine — `ryph-runs` is default-deny with NO ingress rule, so nothing in
// the cluster can reach a run's database. Version floor 1.29, where sidecars are beta and on by
// default; below it the kubelet ignores `restartPolicy` on an init container and the Job would
// simply never start, so the adapter asks the API server and refuses by name instead.
//
// The run's SIZE CLASS is the runner container's requests and limits, and — when the class names
// a `work-volume` — a generic ephemeral volume mounted at /ryph/work: a PVC the pod creates and
// the garbage collector deletes with it, which is how a run gets more disk than Autopilot's 10Gi
// ephemeral cap. The volume shadows whatever the image holds at that path, so a first init
// container copies the image's /ryph/work (an environment image's warm checkout) onto it before
// anything else starts: boot time spent to buy disk, the trade the size class names.
//
// The BROWSER (`LaunchSpec.browser`, core/browser.ts) is one more native sidecar, after the
// services: the platform's image, so it runs under the RUNNER's confinement (uid, `drop: ALL`, no
// escalation) rather than a catalogue's, and gets no Secret and one env var, the sandbox policy
// (`RYPH_BROWSER_SANDBOX=required` under a runtimeClass, where Chromium's own sandbox is known to
// work) — the runner hands it its bearer and the egress credentials over localhost once both are
// up. It has NO startupProbe, unlike a service: a probe would hold the runner back until the
// browser answered, so a crash-looping browser would stop the run, and it binds 127.0.0.1 only,
// where a kubelet's probe cannot reach it anyway. The runner's own one-minute wait decides, and a
// browser that never answers is a run without one. Its cpu and memory go on top of the size class,
// and its ephemeral storage comes out of the runner's share, exactly like a service — and a class
// with no room left for it is a run granted no browser (`browserRefusal`), never a refused launch.
//
// What IS fatal: an unpullable browser IMAGE. The kubelet pulls every init container before the
// next one starts, so a native sidecar whose image will not pull holds the pod in `Init:` and the
// run is lost at the startup grace. Accepted, because RYPH_BROWSER_IMAGE is a digest-pinned image
// the operator configures, and one that does not pull is a misconfigured deployment rather than a
// browser that failed — the same as an unpullable RYPH_AGENT_IMAGE.
//
// RESERVED CAPACITY (`capacity`) is one Deployment per size class, `ryph-reserve-<class>`, whose
// pods ask for the largest pod a run or check of that class can ask for: the class plus as many
// service sidecars as the policy allows, each at the most one can get (`placeholderResources`).
// Shaped for a run with no services, a slot was too small to evict for one with them: the
// scheduler found preemption not helpful and the autoscaler made a node anyway. They run under the
// same RuntimeClass, at one of ten non-preempting PriorityClasses from -10 to -1, by half-octaves
// of the cpu they hold (`placeholderRungs`), so a run evicts the smallest placeholder that makes
// room for it, in any cell; each holds a node of its own (anti-affinity on one another), which the
// ladder needs. A real run, check or build pod runs at `ryph-workload` (0), named on the pod
// rather than left to whatever `globalDefault` the cluster has, so it evicts one the moment it
// needs the room; the evicted placeholder goes Pending, the autoscaler adds a node for it, and the
// reservation refills itself. -10 and not lower because the cluster autoscaler ignores pods BELOW
// -10 and would never scale up for an evicted one. The
// container is the agent image running `sleep infinity`, not a pause image: the nodes are private
// and already pull from the agent image's registry, and a reserved node then holds the layers
// every run starts from. Each placeholder holds nothing else: no token, no env, no volume, no
// port, no network rule names it, and it meets `restricted` on its own.
//
// A ROLLOUT puts two configurations on the cluster at once: the old control plane and the new one
// each apply their own agent image and RYPH_RUN_SIZES, and under `Recreate` every flip of the image
// restarts every placeholder. So one replica applies at a time: the holder of a coordination.k8s.io
// Lease, `ryph-reserved-capacity`, in the runs namespace (so each cell has its own). This adapter
// only stores it (`lease`, @ryph/service's Kubernetes store); who holds it is @ryph/service's
// `makeLease`, driven by core/reserved_capacity.ts: taken when absent, released, or unchanged for
// its duration by the taker's own clock, renewed on every pass, and every write to it carries the
// resourceVersion it read, so two replicas racing for it get one 409 and one holder. The old
// replica keeps applying the old configuration until it exits and gives the Lease up; the new one
// takes it at its next pass. Nothing about the placeholders themselves says who wrote them.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { type CaFetch, caFetch, kubernetesLeaseStore } from "@ryph/service";
import type {
  BrowserLaunch,
  CapacityReserver,
  LaunchSpec,
  Provisioner,
  ReservationStatus,
  RunSize,
  ServiceRoom,
  ServiceSpec,
} from "../../ports/provisioner.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import {
  CHECK_FLOOR,
  quantityBytes,
  quantityCores,
  RUNNER_EPHEMERAL_FLOOR,
  SERVICE_EPHEMERAL_STORAGE,
} from "../../core/run_sizes.ts";
import { reservable } from "../../core/reserved_capacity.ts";

/** Where a pod finds its own identity; the in-cluster defaults below read it. */
const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/** The container's name inside the run's pod — what `kubectl logs -c` takes. */
const CONTAINER = "runner";

/**
 * The uid and gid the runner container is pinned to, unless `RYPH_K8S_RUN_USER` says otherwise.
 *
 * An image's `USER runner` is the image's property; a kubelet can only refuse root for a NUMBER,
 * which is why the ToolHost pins its pods the same way (mcp-gateway's adapters/tool_host/cli.ts).
 * 1994 is the run user every image we ship pins (images/env/universal/Dockerfile creates it, and
 * the harness layer's `USER 1994:1994` holds it on any environment), and /ryph/work and the
 * toolchain homes in those images are owned by it, so a different uid there is an unwritable clone
 * and a toolchain that cannot install a pinned version. Operators who point RYPH_AGENT_IMAGE at an
 * image of their own set the variable to its user.
 */
const DEFAULT_RUN_USER = "1994:1994";

/** The lowest minor where restartable init containers are on by default (GA in 1.33). */
const SIDECAR_MINOR_FLOOR = 29;

/**
 * The startup gate on each service: two seconds apart, ninety times. Three minutes is generous
 * for a database's first boot and well inside the reaper's 600s startup grace, so a service
 * that is merely slow is waited for and one that is broken is still the reaper's to end.
 *
 * Note what this does NOT do: a restartable init container whose startupProbe keeps failing is
 * restarted, forever — the Pod stays in `Init:` and the Job reaches neither Complete nor Failed.
 * What ends such a pod is the reaper, or the Job's `activeDeadlineSeconds` — set from the run's
 * wall-clock limit (`LaunchSpec.deadlineSeconds`) as the backstop that needs no orchestrator
 * alive. What this adapter owes the reaper either way is EVIDENCE — see the status capture in
 * `kill`.
 */
const PROBE_PERIOD_SECONDS = 2;
const PROBE_FAILURE_THRESHOLD = 90;

/** Where a size class's work volume is mounted: the baked checkout's path in every image. */
export const WORK_DIR = "/ryph/work";

/** The work volume's name inside the pod, and where the seeding init container sees it. */
const WORK_VOLUME = "work";
const WORK_SEED_DIR = "/ryph/work-volume";

function formatBytes(bytes: number): string {
  const clamped = Math.max(0, bytes);
  return clamped % 2 ** 30 === 0 ? `${clamped / 2 ** 30}Gi` : `${Math.floor(clamped / 2 ** 20)}Mi`;
}

/**
 * The runner container's resources once `serviceCount` sidecars share its pod — the services,
 * and the browser when the run has one.
 *
 * Ephemeral storage is a POD budget, and only ephemeral storage: Autopilot's general-purpose
 * class refuses a pod whose containers ask for more than 10Gi of it in total, so the configured
 * quantity is what the whole pod gets and the runner keeps what the services leave. CPU and
 * memory are added on top instead. The refusal that motivated this named storage alone, with the
 * pod asking for three CPUs and 4GiB, and paying for a database with the agent's memory would
 * starve the agent to feed its own test suite.
 *
 * Throws when the services would leave the runner under its floor. Refused here, naming the
 * operator's size class, rather than by an admission webhook naming a pod nobody asked for — or,
 * off Autopilot, by an eviction mid-run.
 *
 * `work-volume` is not a container resource and is not in the answer: it is a volume, and its
 * bytes are the PVC's, not the pod's ephemeral budget.
 */
export function runnerResources(
  size: RunSize,
  serviceCount: number,
): Record<string, string> {
  const configured: Record<string, string> = {
    ...(size.cpu === null ? {} : { cpu: size.cpu }),
    ...(size.memory === null ? {} : { memory: size.memory }),
    ...(size.ephemeralStorage === null ? {} : { "ephemeral-storage": size.ephemeralStorage }),
  };
  const storage = size.ephemeralStorage;
  if (storage === null || serviceCount === 0) return configured;
  const remaining = quantityBytes(storage) -
    serviceCount * quantityBytes(SERVICE_EPHEMERAL_STORAGE);
  if (remaining < quantityBytes(RUNNER_EPHEMERAL_FLOOR)) {
    throw new Error(
      `size class "${size.name}" (RYPH_RUN_SIZES) gives each run's pod ` +
        `ephemeral-storage=${storage}, and this run's ` +
        `${serviceCount} sidecar(s) (service containers, and the browser when it has one) take ` +
        `${SERVICE_EPHEMERAL_STORAGE} each, which leaves the runner ${formatBytes(remaining)} — ` +
        `under the ${RUNNER_EPHEMERAL_FLOOR} its clone needs. Raise the class's ` +
        "ephemeral-storage, or declare fewer services.",
    );
  }
  return { ...configured, "ephemeral-storage": formatBytes(remaining) };
}

export interface KubernetesOptions {
  /** The API server's origin, e.g. `https://10.0.0.1:443`, or a `kubectl proxy` address. */
  apiUrl: string;
  /** The namespace runs launch into. Its own namespace, apart from the services, is the intent. */
  namespace: string;
  /**
   * A bearer token file, re-read on every request because a projected token rotates underneath
   * the process. Null when the API is reached through something that authenticates for us.
   */
  tokenFile: string | null;
  /** The PEM bundle the API server's certificate chains to. Null means the system roots. */
  caFile: string | null;
  /** The run pod's service account. Unset is the namespace's `default`. */
  serviceAccount?: string;
  /** The RuntimeClass every run pod gets — `gvisor`, a Kata class — i.e. the run's boundary. */
  runtimeClass?: string;
  /**
   * The GKE ComputeClass every check pod asks for, by node selector. Unset leaves checks on
   * whatever nodes the cluster picks. On Autopilot that is a container-optimized `ek` node, and
   * gVisor sizes a sandbox's vCPUs once, at start, from the CPUs the node has online then. A
   * fresh `ek` node has only a few online, so a check pod there sees 2 CPUs of its 7 for life.
   */
  checkComputeClass?: string;
  /** The uid and gid the runner container is pinned to. See DEFAULT_RUN_USER. */
  runUser: { uid: number; gid: number };
  /**
   * The StorageClass a size class's work volume is provisioned from. Unset is the cluster's
   * default class — `standard-rwo` (balanced persistent disk) on GKE Autopilot.
   */
  workVolumeClass?: string;
  /**
   * Seconds between SIGTERM and SIGKILL — the runner's graceful-cancel window, in which it
   * finishes the current action, commits, and pushes. Docker's 10s is far too short for that.
   */
  stopGraceSeconds?: number;
  /** How long a finished run's Job (and pod, and Secret) stays for `kubectl logs` before GC. */
  ttlSecondsAfterFinished?: number;
}

export interface KubernetesDeps {
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Who this process is to the reserved capacity Lease; defaults to the pod name plus a nonce. */
  leaseHolder?: string;
}

// The few manifest shapes this adapter writes and reads, narrowed to the fields it touches.
type Labels = Record<string, string>;
interface ObjectMeta {
  name: string;
  namespace?: string;
  labels?: Labels;
  annotations?: Record<string, string>;
  uid?: string;
  generation?: number;
  deletionTimestamp?: string;
  ownerReferences?: Array<{ apiVersion: string; kind: string; name: string; uid: string }>;
}
export interface JobManifest {
  apiVersion: "batch/v1";
  kind: "Job";
  metadata: ObjectMeta;
  spec: Record<string, unknown>;
  status?: {
    active?: number;
    conditions?: Array<{ type: string; status: string }>;
  };
}
interface ContainerSpec {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  restartPolicy?: "Always";
  securityContext: Record<string, unknown>;
  resources?: { requests: Record<string, string>; limits: Record<string, string> };
  startupProbe?: Record<string, unknown>;
  envFrom?: Array<{ secretRef: { name: string } }>;
  volumeMounts?: Array<{ name: string; mountPath: string }>;
}

export interface SecretManifest {
  apiVersion: "v1";
  kind: "Secret";
  metadata: ObjectMeta;
  type: "Opaque";
  stringData: Record<string, string>;
}

/** Job, Secret, and pod share one name; `kubectl get job,secret -l ryph.run=<id>` finds both. */
export function jobName(runId: string): string {
  return `ryph-run-${runId}`;
}

function labelsFor(runId: string): Labels {
  // `ryph.run` is the label the docker adapter puts on its containers: one key, whichever
  // backend a run landed on. The pod carries
  // `component` too, so a NetworkPolicy can select every run without naming one.
  return {
    "app.kubernetes.io/managed-by": "ryph",
    "app.kubernetes.io/component": "agent-run",
    "ryph.run": runId,
  };
}

/**
 * Docker's memory spelling as a Kubernetes quantity. NOT cosmetic: `512m` in a pod spec is 512
 * MILLIBYTES, which the API server accepts and the kubelet enforces — a limit no process can
 * run under. Duplicated from @ryph/mcp-gateway's kubernetes tool host, which learned it the
 * same way; every memory cap crossing this boundary goes through here.
 */
export function quantity(memory: string): string {
  const match = memory.match(/^([1-9][0-9]{0,4})([mg])$/i);
  if (match === null) throw new Error(`not a memory cap this adapter understands: ${memory}`);
  return `${match[1]}${match[2].toLowerCase() === "g" ? "Gi" : "Mi"}`;
}

/**
 * One service as a native sidecar.
 *
 * `restartPolicy: Always` on an init container is what makes it a sidecar: started before the
 * regular containers, kept running beside them, and — the part that matters for a Job —
 * terminated when they exit, so the Job can finish. The `startupProbe` is what makes the
 * ORDERING real: the kubelet does not start the next container until this one passes, so the
 * runner is not even launched until its database answers. The runner waits again on its own
 * side; that is not redundancy, it is the difference between a guarantee the platform gives on
 * one backend and a guarantee the runner gives on all of them.
 *
 * Confinement is the catalogue's, added back on top of `drop: ALL`. Never the runtime default:
 * that includes CAP_NET_RAW, in this pod's network namespace, where every hop in this
 * deployment is plaintext HTTP carrying the run token. See the adapter header on what the run's
 * Secret already protects and what this would undo.
 */
export function sidecarContainer(service: ServiceSpec): ContainerSpec {
  const resources = {
    cpu: service.resources.cpus,
    memory: quantity(service.resources.memory),
    "ephemeral-storage": SERVICE_EPHEMERAL_STORAGE,
  };
  return {
    name: `svc-${service.name}`,
    image: service.image,
    restartPolicy: "Always",
    // `args`, NOT `command`. Kubernetes `command` overrides the image's ENTRYPOINT and `args`
    // overrides its CMD; docker's trailing argv overrides CMD alone. Writing the declaration
    // to `command` here would mean `postgres -p 5433` runs as PID 1 with docker-entrypoint.sh
    // skipped — no initdb, no privilege drop, no init scripts — so the same two lines of YAML
    // would behave completely differently on the two backends. The declaration means "the
    // arguments", on both.
    ...(service.command ? { args: [...service.command] } : {}),
    ...(Object.keys(service.env).length > 0
      ? { env: Object.entries(service.env).map(([name, value]) => ({ name, value })) }
      : {}),
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: {
        drop: ["ALL"],
        ...(
          service.security.capabilities.length > 0
            ? { add: [...service.security.capabilities] }
            : {}
        ),
      },
    },
    // Request AND limit, as the runner container gets. A restartable init container counts into
    // the pod's requests, so its storage comes out of the runner's share — see runnerResources.
    resources: { requests: resources, limits: resources },
    startupProbe: {
      tcpSocket: { port: service.port },
      periodSeconds: PROBE_PERIOD_SECONDS,
      failureThreshold: PROBE_FAILURE_THRESHOLD,
    },
  };
}

/** The browser sidecar's container name — what `kubectl logs -c browser` takes. */
export const BROWSER_CONTAINER = "browser";

/**
 * The browser as a native sidecar, for `sidecarContainer`'s reasons: started before the runner,
 * kept beside it, and terminated when it exits so the Job can complete. Deliberately NO
 * startupProbe (see the header): the runner does not wait on the kubelet for it, it waits on the
 * port itself and gives up after a minute, so a broken browser costs the run its browser and
 * nothing else.
 *
 * Confinement is the RUNNER's, passed in, not a catalogue's: this is the platform's image, built
 * to run as the run user with nothing added back, and Chromium's own sandbox needs no capability
 * under gVisor (it takes a user namespace of its own, measured). The pod's seccomp profile and
 * RuntimeClass apply to it as to every container in the pod.
 *
 * Its one env var is the sandbox policy: `required` under a runtimeClass (gVisor), where the
 * sandbox works and a browser without it should refuse to start rather than quietly run
 * unsandboxed; unset elsewhere, which is the sidecar's try-then-fall-back.
 */
export function browserContainer(
  browser: BrowserLaunch,
  security: Record<string, unknown>,
  runtimeClass?: string,
): ContainerSpec {
  const resources = {
    ...(browser.resources.cpu === null ? {} : { cpu: browser.resources.cpu }),
    ...(browser.resources.memory === null ? {} : { memory: browser.resources.memory }),
    "ephemeral-storage": SERVICE_EPHEMERAL_STORAGE,
  };
  return {
    name: BROWSER_CONTAINER,
    image: browser.image,
    restartPolicy: "Always",
    ...(runtimeClass ? { env: [{ name: BROWSER_SANDBOX_ENV, value: "required" }] } : {}),
    securityContext: security,
    resources: { requests: resources, limits: resources },
  };
}

/** The browser sidecar's sandbox policy (`required` | `off`; unset: try, then fall back). */
export const BROWSER_SANDBOX_ENV = "RYPH_BROWSER_SANDBOX";

/**
 * Why a run of class `size` with `serviceCount` service containers cannot also hold the browser,
 * or null when it can: the browser's ephemeral storage comes out of the runner's share, and a
 * class with none left for it would fail the whole launch (`runnerResources`). Only the browser's
 * own straw is counted — a class the services alone break is refused at launch as before.
 */
export function browserStorageRefusal(size: RunSize, serviceCount: number): string | null {
  try {
    runnerResources(size, serviceCount);
  } catch {
    return null;
  }
  try {
    runnerResources(size, serviceCount + 1);
    return null;
  } catch {
    return `size class "${size.name}" has no ephemeral storage left for it (its ` +
      `${SERVICE_EPHEMERAL_STORAGE} would leave the runner under the ${RUNNER_EPHEMERAL_FLOOR} ` +
      "its clone needs)";
  }
}

/**
 * The Job one launch creates — suspended; see the header for why. Pure, and exported for the
 * test: this manifest is the contract between the orchestrator and the run's pod, as the argv is
 * for docker.
 */
export function jobManifest(spec: LaunchSpec, opts: KubernetesOptions): JobManifest {
  if (spec.image === null) {
    throw new Error(
      "no agent-container image configured (set RYPH_AGENT_IMAGE)",
    );
  }
  const services = spec.services ?? [];
  const browser = spec.browser ?? null;
  const name = jobName(spec.runId);
  const labels = labelsFor(spec.runId);
  const runner = runnerResources(spec.size, services.length + (browser === null ? 0 : 1));
  const resources = Object.keys(runner).length > 0
    ? { requests: runner, limits: runner }
    : undefined;
  // No setuid escalation, no capabilities, and not root — the uid given as a number rather than
  // read off the image, which is the part a kubelet can verify. An image's `USER` is the image's
  // promise and RYPH_AGENT_IMAGE is operator config, so without this an image built with no USER
  // runs model-authored shell as uid 0. The work volume's seeding container runs the same image
  // as the same user, under the same rules.
  const runnerSecurity = {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    runAsNonRoot: true,
    runAsUser: opts.runUser.uid,
    runAsGroup: opts.runUser.gid,
  };
  const workVolume = spec.size.workVolume;
  const initContainers: ContainerSpec[] = [
    // FIRST, before the sidecars: it copies the image's /ryph/work onto the volume that is about
    // to shadow it, and nothing may start on a half-copied checkout. `cp -a` keeps mtimes, which
    // is what keeps a warm build warm.
    // The children, not the directory: copying `.` onto the volume's root would try to set the
    // root's own times and owner, which uid 1994 may not, and fail the pod over metadata.
    // bash, not sh: bash is one of the three things the harness layer requires of any base.
    ...(workVolume === null ? [] : [{
      name: "seed-work",
      image: spec.image,
      command: [
        "/bin/bash",
        "-c",
        `shopt -s dotglob nullglob; set -- ${WORK_DIR}/*; ` +
        `if [ "$#" -gt 0 ]; then cp -a "$@" ${WORK_SEED_DIR}/; fi`,
      ],
      securityContext: runnerSecurity,
      ...(resources ? { resources } : {}),
      volumeMounts: [{ name: WORK_VOLUME, mountPath: WORK_SEED_DIR }],
    }]),
    ...services.map(sidecarContainer),
    // Last: nothing waits on it, and a run whose services never come up should say so about the
    // service rather than wait on a browser first.
    ...(browser === null ? [] : [browserContainer(browser, runnerSecurity, opts.runtimeClass)]),
  ];
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: opts.namespace, labels },
    spec: {
      suspend: true,
      backoffLimit: 0,
      ttlSecondsAfterFinished: opts.ttlSecondsAfterFinished ?? 3600,
      // The run's wall clock plus the orchestrator's graces: the reaper cancels first, and this
      // ends the Job when nothing else could. Counted from the Job's start, image pull included.
      ...(spec.deadlineSeconds === undefined
        ? {}
        : { activeDeadlineSeconds: spec.deadlineSeconds }),
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          terminationGracePeriodSeconds: opts.stopGraceSeconds ?? 120,
          priorityClassName: WORKLOAD_PRIORITY_CLASS,
          ...(opts.serviceAccount ? { serviceAccountName: opts.serviceAccount } : {}),
          ...(opts.runtimeClass ? { runtimeClassName: opts.runtimeClass } : {}),
          // Docker applies its default seccomp profile to every container; a kubelet does not
          // unless it was told to. This keeps a run's syscall surface where docker leaves it.
          //
          // Pod-level, this is all there is, and the sidecars inherit it — as they do
          // runtimeClassName and the denied service account token. The uid belongs on the
          // CONTAINER below rather than here, because a pod-level uid applies to every
          // container in the pod, and a run's pod also carries the service containers a task
          // asks for — vendor images that start as root and drop privileges themselves.
          //
          // `fsGroup` only with a work volume: it is what makes a freshly provisioned disk —
          // root-owned, like every new filesystem — writable by the run's uid, and it changes
          // nothing else the pod mounts, because nothing else is mounted.
          securityContext: {
            seccompProfile: { type: "RuntimeDefault" },
            ...(workVolume === null
              ? {}
              : { fsGroup: opts.runUser.gid, fsGroupChangePolicy: "OnRootMismatch" }),
          },
          // A generic ephemeral volume: the PVC is created with the pod, named for it, owned by
          // it, and deleted with it, so there is no second object for kill or the TTL to clean.
          ...(workVolume === null ? {} : {
            volumes: [{
              name: WORK_VOLUME,
              ephemeral: {
                volumeClaimTemplate: {
                  metadata: { labels },
                  spec: {
                    accessModes: ["ReadWriteOnce"],
                    ...(opts.workVolumeClass ? { storageClassName: opts.workVolumeClass } : {}),
                    resources: { requests: { storage: workVolume } },
                  },
                },
              },
            }],
          }),
          // THE CONTRACT: the declared name is the hostname. Sidecars share the pod's network
          // namespace, so every service is on loopback — but `localhost` is not what a repo
          // writes, because it would not work under docker, where the services are on a
          // separate network. One spelling, every backend.
          ...(services.length > 0
            ? { hostAliases: [{ ip: "127.0.0.1", hostnames: services.map((s) => s.name) }] }
            : {}),
          ...(initContainers.length > 0 ? { initContainers } : {}),
          containers: [{
            name: CONTAINER,
            image: spec.image,
            envFrom: [{ secretRef: { name } }],
            securityContext: runnerSecurity,
            ...(resources ? { resources } : {}),
            // A run on an image with no baked checkout clones into a temp dir, which would be on
            // the container's capped ephemeral storage rather than the disk the class bought; so
            // its temp checkout goes on the volume too. A baked run works in /ryph/work anyway.
            ...(workVolume === null ? {} : {
              env: [{ name: "RUNNER_CHECKOUT_ROOT", value: WORK_DIR }],
              volumeMounts: [{ name: WORK_VOLUME, mountPath: WORK_DIR }],
            }),
          }],
        },
      },
    },
  };
}

/** The Secret carrying the run's contract env, owned by the Job so it dies with it. */
export function secretManifest(
  spec: LaunchSpec,
  opts: Pick<KubernetesOptions, "namespace">,
  jobUid: string,
): SecretManifest {
  const name = jobName(spec.runId);
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name,
      namespace: opts.namespace,
      labels: labelsFor(spec.runId),
      ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name, uid: jobUid }],
    },
    type: "Opaque",
    stringData: spec.env,
  };
}

/**
 * What a Job says about its run, in the port's three words. Exported for the test.
 *
 * Everything short of a finished condition is running — suspended, pending a node, pulling —
 * because the run exists and must not be launched again. A Job being deleted counts as exited:
 * a kill has been issued and taken.
 */
export function jobState(job: JobManifest): "running" | "exited" {
  if (job.metadata.deletionTimestamp) return "exited";
  const finished = (job.status?.conditions ?? []).some((c) =>
    (c.type === "Complete" || c.type === "Failed") && c.status === "True"
  );
  return finished ? "exited" : "running";
}

/** A handle is `<namespace>/<job>` — the namespace rides along so a reconfigured one still kills. */
function parseHandle(handle: string): { namespace: string; name: string } {
  const slash = handle.indexOf("/");
  if (slash <= 0 || slash === handle.length - 1) {
    throw new Error(`not a kubernetes run handle: ${JSON.stringify(handle)}`);
  }
  return { namespace: handle.slice(0, slash), name: handle.slice(slash + 1) };
}

/**
 * How many priority rungs placeholders have: PriorityClasses `ryph-reserved-capacity-0` (-10) to
 * `-9` (-1), all non-preempting (deploy/helm/ryph/templates/priorityclasses.yaml). Ten: more distinct
 * placeholder sizes than any RYPH_RUN_SIZES we have seen, and all there is between -10, the
 * lowest the cluster autoscaler still scales up for, and 0, `ryph-workload`.
 */
export const RESERVE_RUNGS = 10;

/** The PriorityClass of one rung, 0 the lowest (-10). */
export function reservePriorityClass(rung: number): string {
  return `ryph-reserved-capacity-${rung}`;
}

/**
 * The PriorityClass every run, check and build pod runs at (the same file): 0, the value a pod
 * gets on a cluster with no `globalDefault` class. Named rather than left unset, because on a
 * cluster whose default is -10 or lower an unnamed run would tie with or rank below a placeholder
 * and wait behind the room reserved for it.
 */
export const WORKLOAD_PRIORITY_CLASS = "ryph-workload";

/** The component label every placeholder carries, and what `apply` lists them back by. */
const RESERVE_COMPONENT = "reserved-capacity";

/** Which size class a placeholder holds room for. */
const SIZE_CLASS_LABEL = "ryph.size-class";

/**
 * Who owns a placeholder's fields under server-side apply. One name for every replica, so two
 * replicas applying the same manifest are one owner agreeing with itself, not two in conflict.
 */
const FIELD_MANAGER = "ryph-control-plane";

/** The Lease whose holder is the one replica that applies placeholders, in the runs namespace. */
export const RESERVE_LEASE = "ryph-reserved-capacity";

/**
 * This process's name on the Lease: the pod's (HOSTNAME, which Kubernetes sets to it) and a
 * nonce, so a container restarted inside the same pod is a new holder rather than its old self.
 */
function defaultLeaseHolder(): string {
  let host = "ryph";
  try {
    host = process.env.HOSTNAME || host;
  } catch {
    // No env permission: the nonce alone still tells processes apart.
  }
  return `${host}-${crypto.randomUUID().slice(0, 8)}`;
}

/** The labels that find every placeholder, as a selector. */
const RESERVE_SELECTOR =
  `app.kubernetes.io/managed-by=ryph,app.kubernetes.io/component=${RESERVE_COMPONENT}`;

/** Whether a placeholder is its class's own, `ryph-reserve-<class>`, rather than a stray. */
function canonical(deployment: DeploymentManifest): boolean {
  const sizeClass = deployment.metadata.labels?.[SIZE_CLASS_LABEL];
  return sizeClass !== undefined && deployment.metadata.name === placeholderName(sizeClass);
}

/** A class name is a slug of at most 32, so this stays well inside a DNS label. */
export function placeholderName(sizeClass: string): string {
  return `ryph-reserve-${sizeClass}`;
}

export interface DeploymentManifest {
  apiVersion: "apps/v1";
  kind: "Deployment";
  metadata: ObjectMeta;
  spec: Record<string, unknown>;
  status?: { readyReplicas?: number; updatedReplicas?: number; observedGeneration?: number };
}

/**
 * How many of `room`'s services fit in one pod of this class. Each sidecar carves its ephemeral
 * storage out of the class's, and what it leaves must stay at or above a floor: the runner's for a
 * run (`runnerResources`), CHECK_FLOOR for each check of a suite (`checkShare`). A one-check suite
 * is the most a pod of the class can carry, so the looser of the two floors caps the count, and no
 * run or check of the class can have more than this.
 */
export function servicesHeld(size: RunSize, room: ServiceRoom): number {
  if (size.ephemeralStorage === null) return room.count;
  const floor = Math.min(quantityBytes(RUNNER_EPHEMERAL_FLOOR), quantityBytes(CHECK_FLOOR));
  const spare = quantityBytes(size.ephemeralStorage) - floor;
  return Math.max(
    0,
    Math.min(room.count, Math.floor(spare / quantityBytes(SERVICE_EPHEMERAL_STORAGE))),
  );
}

/**
 * A cpu quantity in whole millicores, rounded up as the API server rounds a finer one, so a sum
 * of them is never less than what the pods it stands for are held to.
 */
function millicores(value: string): number {
  return Math.ceil(Number((quantityCores(value) * 1000).toFixed(6)));
}

/**
 * One placeholder's resources: the largest pod a run or a check of this class can ask for, as one
 * container. That is the class's cpu and memory plus `servicesHeld` sidecars at the policy's cpu
 * and the largest memory one can get, plus the browser's cpu and memory when the deployment runs
 * one, and the class's ephemeral storage whatever the count, because the sidecars carve theirs out
 * of it. The browser is counted on top of every held service although a run with a browser has
 * room for one service fewer: a slot a little too big is evicted all the same, one too small is
 * not, which is the failure this whole shape exists to avoid. Only a reservable class (core/reserved_capacity.ts)
 * gets a placeholder, and that sets all three: a dimension left unset would be defaulted per
 * container, and no one container could stand for that.
 *
 * A check pod of the class never asks for more. Its init containers each take the class and run
 * before the sidecars start; its checks split the class between them and the sidecars add theirs,
 * so the pod's request, the larger of the two phases, is at most the class plus its sidecars.
 *
 * With no services held and no browser, this is the runner's own resources, spelled as the class
 * spells them.
 */
export function placeholderResources(size: RunSize, room: ServiceRoom): Record<string, string> {
  const count = servicesHeld(size, room);
  const browser = room.browser;
  if (count === 0 && browser === null) return runnerResources(size, 0);
  const sidecars = count + (browser === null ? 0 : 1);
  const cpu = (size.cpu === null ? 0 : millicores(size.cpu)) + count * millicores(room.cpus) +
    (browser?.cpus == null ? 0 : millicores(browser.cpus));
  const memory = (size.memory === null ? 0 : quantityBytes(size.memory)) +
    count * quantityBytes(quantity(room.memory)) +
    (browser?.memory == null ? 0 : quantityBytes(browser.memory));
  const disk = size.ephemeralStorage === null
    ? sidecars * quantityBytes(SERVICE_EPHEMERAL_STORAGE)
    : quantityBytes(size.ephemeralStorage);
  return {
    cpu: cpu % 1000 === 0 ? String(cpu / 1000) : `${cpu}m`,
    memory: exactBytes(memory),
    "ephemeral-storage": exactBytes(disk),
  };
}

/** Bytes as a quantity with nothing rounded away: Gi or Mi when whole, plain bytes otherwise. */
function exactBytes(bytes: number): string {
  if (bytes % 2 ** 30 === 0) return `${bytes / 2 ** 30}Gi`;
  if (bytes % 2 ** 20 === 0) return `${bytes / 2 ** 20}Mi`;
  return String(bytes);
}

/**
 * Each placeholder's rung, by the cpu it holds (`placeholderResources`): smaller is lower. The
 * scheduler preempts on the node whose highest-priority victim is lowest, so with the smaller slot
 * lower, a run that fits in either evicts the smallest placeholder that makes room for it and
 * leaves the larger class's slot warm; at one priority for all, it could take the large slot and
 * leave the large class cold.
 *
 * The rung is an absolute scale, not a rank among this deployment's classes: the PriorityClasses
 * are shared by every cell on the cluster, and a run in one cell may evict another cell's
 * placeholder, so the same size must sit on the same rung in every cell. Half an octave of cpu
 * per rung, from 1 core: rung r holds `[2^(r/2), 2^((r+1)/2))` cores, so 0 is under 1.41 cores
 * (and everything smaller), 4 is 4 to 5.65, and 9 is 22.6 cores and up. Classes in one band share
 * a rung and preemption does not tell them apart; neither does it two slots past 22.6 cores.
 * Memory and disk never move a rung, so a memory-heavy class with less cpu sits below a smaller
 * one and gives its slot up to that one's runs (packages/orchestrator/docs/kubernetes.md).
 *
 * It depends on the configured class alone, whatever is saved for it, so a save never moves a
 * rung (which would restart that class's placeholders). Pure, and exported for the test.
 */
export function placeholderRungs(sizes: RunSize[], room: ServiceRoom): Map<string, number> {
  return new Map(
    sizes.filter(reservable).map((size) => {
      const held = placeholderResources(size, room).cpu;
      return [size.name, cpuRung(held === undefined ? 0 : millicores(held))];
    }),
  );
}

/** The rung of `m` millicores: the largest r below RESERVE_RUNGS with m >= 1000 * 2^(r/2). */
function cpuRung(m: number): number {
  // m^2 >= 10^6 * 2^r, in integers, so a whole power of two lands on its own rung exactly.
  let rung = 0;
  while (rung + 1 < RESERVE_RUNGS && m * m >= 1_000_000 * 2 ** (rung + 1)) rung++;
  return rung;
}

/**
 * One size class's placeholders: `slots` pods holding `placeholderResources`, at the priority of
 * their `rung` (`placeholderRungs`), which anything real evicts. Pure, and exported for the test,
 * because this manifest is the whole of what a placeholder may do.
 *
 * `Recreate`, not a rolling update: a rollout would ask for a surge pod, which is a node, on every
 * image change. Runs set no nodeSelector, tolerations or affinity, so neither does this; the
 * RuntimeClass is what steers both onto the same nodes (GKE Sandbox on GKE).
 *
 * One placeholder to a node, of any class and in any cell (required anti-affinity on the
 * component, across namespaces). The ladder rests on it: the scheduler weighs a node by its
 * highest victim, so two `standard` slots packed onto one node would both go to a `large` run that
 * its own slot on another node could have taken.
 */
export function placeholderManifest(
  size: RunSize,
  slots: number,
  image: string,
  room: ServiceRoom,
  opts: Pick<KubernetesOptions, "namespace" | "runtimeClass" | "serviceAccount" | "runUser">,
  rung: number,
): DeploymentManifest {
  const labels: Labels = {
    "app.kubernetes.io/managed-by": "ryph",
    "app.kubernetes.io/component": RESERVE_COMPONENT,
    [SIZE_CLASS_LABEL]: size.name,
  };
  const resources = placeholderResources(size, room);
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: placeholderName(size.name),
      namespace: opts.namespace,
      labels,
    },
    spec: {
      replicas: slots,
      strategy: { type: "Recreate" },
      revisionHistoryLimit: 1,
      selector: {
        matchLabels: {
          "app.kubernetes.io/component": RESERVE_COMPONENT,
          [SIZE_CLASS_LABEL]: size.name,
        },
      },
      template: {
        metadata: { labels },
        spec: {
          priorityClassName: reservePriorityClass(rung),
          affinity: {
            podAntiAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: [{
                labelSelector: {
                  matchLabels: {
                    "app.kubernetes.io/managed-by": "ryph",
                    "app.kubernetes.io/component": RESERVE_COMPONENT,
                  },
                },
                namespaceSelector: {},
                topologyKey: "kubernetes.io/hostname",
              }],
            },
          },
          ...(opts.runtimeClass ? { runtimeClassName: opts.runtimeClass } : {}),
          ...(opts.serviceAccount ? { serviceAccountName: opts.serviceAccount } : {}),
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          // Evicted to make room for a run: nothing to finish, so nothing to wait for.
          terminationGracePeriodSeconds: 0,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: opts.runUser.uid,
            runAsGroup: opts.runUser.gid,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [{
            name: "reserve",
            image,
            // The universal base is Debian, whose coreutils `sleep` takes `infinity`.
            command: ["sleep", "infinity"],
            ...(Object.keys(resources).length > 0
              ? { resources: { requests: resources, limits: resources } }
              : {}),
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
              readOnlyRootFilesystem: true,
              runAsNonRoot: true,
            },
          }],
        },
      },
    },
  };
}

/**
 * The placeholders over the API server, with a request timeout of their own: the run client has
 * none, and a reconcile that hangs on a dead API server must fail into its retry, not sit there.
 */
export function kubernetesCapacity(
  opts: KubernetesOptions,
  doFetch: typeof fetch = globalThis.fetch,
  lease: { holder?: string } = {},
): CapacityReserver {
  // 10 s: under the third of the Lease's hold (20 s at the least) a holder keeps as the margin for
  // a write sent just before its deadline (core/reserved_capacity.ts, `leaseTimings`).
  const call = kubernetesApi(opts, doFetch, { requestTimeoutMs: 10_000 }).call;
  const deployments = `/apis/apps/v1/namespaces/${opts.namespace}/deployments`;

  const list = async (): Promise<DeploymentManifest[]> => {
    const found = await call(
      "GET",
      `${deployments}?labelSelector=${encodeURIComponent(RESERVE_SELECTOR)}`,
    ) as { items?: DeploymentManifest[] } | undefined;
    return found?.items ?? [];
  };

  return {
    lease: kubernetesLeaseStore({ call }, { namespace: opts.namespace, name: RESERVE_LEASE }),
    identity: lease.holder ?? defaultLeaseHolder(),

    async apply({ image, services, reservations, held }) {
      const existing = await list();
      const failures: string[] = [];
      // Checked before every write: a pass that has run this long may no longer hold the Lease,
      // and a write after that could undo what the new holder applied.
      const inTime = (what: string) => {
        if (held()) return;
        throw new Error(
          `stopped before ${what}: this replica no longer holds the Lease by its own deadline; ` +
            "the next pass renews before writing" +
            (failures.length > 0 ? `; earlier: ${failures.join("; ")}` : ""),
        );
      };

      // Server-side apply of the WHOLE manifest, forced: the result is the same whoever applied
      // last and however often, and an unchanged manifest changes nothing on the cluster — no
      // rollout, no pod restarted. A field this manager set once and no longer sends is removed,
      // which is how the placeholders lost the rollout stamps an earlier version wrote.
      //
      // Each class stands alone. One class the API server refuses (a quantity it rejects, an
      // admission webhook, a timeout) must not keep the rest from converging, least of all the
      // deletes: a class turned off would otherwise keep holding nodes for as long as another
      // class fails. Failures are collected and thrown together at the end, so the pass still
      // logs and is retried.
      // Every class wanted above zero, applied or not: one whose apply failed keeps what it
      // holds rather than losing it to the delete below.
      const wanted = new Set<string>();
      const rungs = placeholderRungs(reservations.map((r) => r.size), services);
      for (const { size, slots } of reservations) {
        if (slots <= 0) continue;
        wanted.add(size.name);
        inTime(`apply ${size.name}`);
        try {
          await call(
            "PATCH",
            `${deployments}/${placeholderName(size.name)}?fieldManager=${FIELD_MANAGER}&force=true`,
            placeholderManifest(size, slots, image, services, opts, rungs.get(size.name) ?? 0),
            "application/apply-patch+yaml",
          );
        } catch (err) {
          failures.push(`apply ${size.name}: ${err instanceof Error ? err.message : err}`);
        }
      }
      // Then everything not wanted: a class set to 0, one the configuration no longer has, or any
      // other Deployment carrying our labels under a name that is not the class's own.
      for (const deployment of existing) {
        if (canonical(deployment) && wanted.has(deployment.metadata.labels![SIZE_CLASS_LABEL])) {
          continue;
        }
        inTime(`delete ${deployment.metadata.name}`);
        try {
          await call(
            "DELETE",
            `${deployments}/${deployment.metadata.name}?propagationPolicy=Background`,
          );
        } catch (err) {
          // Already gone, which is the outcome this wanted.
          if (err instanceof KubeError && err.status === 404) continue;
          failures.push(
            `delete ${deployment.metadata.name}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      if (failures.length > 0) throw new Error(failures.join("; "));
    },

    servicesHeld,

    // The class's own Deployment only: a stray one carrying the same labels under another name
    // is about to be deleted, and must not be read as what the class holds.
    async status(): Promise<ReservationStatus[]> {
      return (await list()).flatMap((deployment) =>
        canonical(deployment)
          ? [{
            sizeClass: deployment.metadata.labels![SIZE_CLASS_LABEL],
            ready: currentReady(deployment),
          }]
          : []
      );
    },
  };
}

/**
 * Placeholders that are ready AND on the Deployment's current template. During a rollout
 * `readyReplicas` still counts pods of the previous shape, which may be smaller than the class now
 * needs; until the controller has seen the latest spec nothing it reports is about that spec.
 */
function currentReady(deployment: DeploymentManifest): number {
  const status = deployment.status ?? {};
  if ((status.observedGeneration ?? 0) < (deployment.metadata.generation ?? 0)) return 0;
  return Math.min(status.readyReplicas ?? 0, status.updatedReplicas ?? 0);
}

export class KubeError extends Error {
  override readonly name = "KubeError";
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Where the API server is and how to authenticate to it — the part of the options a client needs. */
export type KubernetesConnection = Pick<KubernetesOptions, "apiUrl" | "tokenFile" | "caFile">;

/** A request to the API server; `call` answers parsed JSON, `text` the body as sent (pod logs). */
export interface KubernetesApi {
  call(method: string, path: string, body?: unknown, contentType?: string): Promise<unknown>;
  text(method: string, path: string): Promise<string>;
}

/**
 * The API server over fetch, as this adapter and the environment builder's kubernetes adapter
 * both speak to it. The token file is re-read on every request because a projected token rotates
 * underneath the process; a CA the process cannot read is a boot failure, not a first-call one.
 */
export function kubernetesApi(
  conn: KubernetesConnection,
  doFetch: typeof fetch = globalThis.fetch,
  opts: { requestTimeoutMs?: number } = {},
): KubernetesApi {
  const apiUrl = conn.apiUrl.replace(/\/+$/, "");
  const ca = conn.caFile === null ? null : readFileSync(conn.caFile, "utf8");
  // With a CA file, only certificates that CA signed are accepted (caFetch). A fetch a caller
  // injected (a test's) is used as given.
  const send: typeof fetch | CaFetch = ca !== null && doFetch === globalThis.fetch
    ? caFetch(ca)
    : doFetch;

  async function request(
    method: string,
    path: string,
    body?: unknown,
    contentType = "application/json",
  ): Promise<string> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (conn.tokenFile !== null) {
      headers.authorization = `Bearer ${(await readFile(conn.tokenFile, "utf8")).trim()}`;
    }
    if (body !== undefined) headers["content-type"] = contentType;
    const res = await send(`${apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // A cap on the request AND its body: a connection that hangs is an error, not a wait.
      ...(opts.requestTimeoutMs ? { signal: AbortSignal.timeout(opts.requestTimeoutMs) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      // The API server answers failures with a Status object whose `message` names the cause.
      let message = text.slice(0, 200);
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        // Not JSON — a proxy's error page, say. The status is what matters; the text rides along.
      }
      throw new KubeError(res.status, `kubernetes ${method} ${path} → ${res.status}: ${message}`);
    }
    return text;
  }

  return {
    async call(method, path, body, contentType) {
      const text = await request(method, path, body, contentType);
      try {
        return text === "" ? undefined : JSON.parse(text);
      } catch {
        return undefined;
      }
    },
    text: (method, path) => request(method, path),
  };
}

export function kubernetesProvisioner(
  opts: KubernetesOptions,
  diag: Diagnostics,
  deps: KubernetesDeps = {},
): Provisioner {
  const call = kubernetesApi(opts, deps.fetch ?? globalThis.fetch).call;

  const jobsPath = (namespace: string) => `/apis/batch/v1/namespaces/${namespace}/jobs`;

  /**
   * Sidecars are beta-and-on from 1.29 and GA in 1.33. Below that the kubelet silently ignores
   * `restartPolicy` on an init container: the "sidecar" runs to completion and the Job never
   * starts the runner, which looks like a hung launch and is really a manifest the cluster does
   * not understand. Asked once and remembered — a cluster does not get older mid-process, and
   * an upgrade restarts this one anyway.
   */
  let sidecarsSupported: boolean | null = null;
  async function probeSidecars(): Promise<boolean> {
    if (sidecarsSupported === null) {
      const version = await call("GET", "/version") as { major?: string; minor?: string };
      // GKE reports "29+"; the trailing plus is why this parses rather than compares.
      const minor = Number.parseInt(String(version.minor ?? ""), 10);
      const major = Number.parseInt(String(version.major ?? ""), 10);
      sidecarsSupported = Number.isFinite(major) && Number.isFinite(minor) &&
        (major > 1 || (major === 1 && minor >= SIDECAR_MINOR_FLOOR));
      diag.debug("kubernetes.version", {
        major: version.major,
        minor: version.minor,
        sidecars: sidecarsSupported,
      });
    }
    return sidecarsSupported;
  }
  async function refuseIfNoSidecars(): Promise<void> {
    if (!(await probeSidecars())) {
      throw new Error(
        `this run has service containers or a browser, which need native sidecars — Kubernetes ` +
          `1.${SIDECAR_MINOR_FLOOR} or newer. This cluster is older, and would run the ` +
          `services to completion instead of beside the run. Upgrade the cluster, use ` +
          `RYPH_PROVISIONER=docker, or turn RYPH_SERVICES off.`,
      );
    }
  }

  /**
   * What the pod looked like, written to the log BEFORE anything is deleted.
   *
   * The failure this exists for: a service whose startupProbe never passes leaves the pod in
   * `Init:`, the Job never finishes, and the reaper eventually marks the run lost — after which
   * `kill` deletes the pod with grace 0 and the container statuses go with it. Without this,
   * the feature is undebuggable by anyone who was not watching `kubectl` live, which is nobody.
   * Best-effort by construction: a kill must never fail because a diagnostic did.
   */
  async function captureStatus(namespace: string, name: string): Promise<void> {
    try {
      const selector = encodeURIComponent(`job-name=${name}`);
      const list = await call(
        "GET",
        `/api/v1/namespaces/${namespace}/pods?labelSelector=${selector}`,
      ) as {
        items?: Array<{
          metadata?: { name?: string };
          status?: {
            phase?: string;
            initContainerStatuses?: unknown[];
            containerStatuses?: unknown[];
          };
        }>;
      };
      for (const pod of list.items ?? []) {
        diag.warn("kubernetes.pod_status_at_kill", {
          pod: pod.metadata?.name,
          phase: pod.status?.phase,
          // The sidecars are the init statuses: "which service never came up" is answered here
          // and nowhere else once the pod is gone.
          initContainers: pod.status?.initContainerStatuses,
          containers: pod.status?.containerStatuses,
        });
      }
    } catch (err) {
      diag.debug("kubernetes.status_capture_failed", { name, err: String(err) });
    }
  }

  async function deleteJob(namespace: string, name: string): Promise<void> {
    try {
      // Background: the Job goes now and the garbage collector deletes its pod — gracefully, with
      // the pod's own terminationGracePeriodSeconds — and its Secret after it.
      await call("DELETE", `${jobsPath(namespace)}/${name}?propagationPolicy=Background`);
    } catch (err) {
      // Gone already is the outcome a kill wants: the reaper re-issues kills, and the TTL
      // controller deletes finished Jobs on its own.
      if (!(err instanceof KubeError && err.status === 404)) throw err;
    }
  }

  return {
    async launch(spec: LaunchSpec) {
      // Before the manifest is written, not after: a cluster that cannot run sidecars must
      // refuse by name rather than create a Job that will never start the runner.
      if ((spec.services?.length ?? 0) > 0 || spec.browser) await refuseIfNoSidecars();
      const job = jobManifest(spec, opts);
      const namespace = opts.namespace;
      const name = job.metadata.name;
      const created = await call("POST", jobsPath(namespace), job) as JobManifest;
      const uid = created.metadata.uid;
      try {
        if (!uid) throw new Error(`kubernetes created job ${name} but returned no uid`);
        await call(
          "POST",
          `/api/v1/namespaces/${namespace}/secrets`,
          secretManifest(spec, opts, uid),
        );
        await call(
          "PATCH",
          `${jobsPath(namespace)}/${name}`,
          { spec: { suspend: false } },
          "application/merge-patch+json",
        );
      } catch (err) {
        // A suspended Job with no Secret is a run that can never start; take it down (and any
        // Secret it already owns) rather than leave it for the reaper's startup grace to find.
        await deleteJob(namespace, name).catch((cleanupErr) =>
          diag.warn("kubernetes.launch_cleanup_failed", {
            runId: spec.runId,
            err: String(cleanupErr),
          })
        );
        throw err;
      }
      const handle = `${namespace}/${name}`;
      diag.debug("kubernetes.launched", {
        runId: spec.runId,
        image: spec.image,
        runtimeClass: opts.runtimeClass ?? "default",
        sizeClass: spec.size.name,
        handle,
      });
      return { handle };
    },

    // Graceful deletes the Job and lets the garbage collector stop the pod with its own grace
    // period: SIGTERM, the runner's graceful cancel, then SIGKILL once the window closes. Hard
    // does the same and then deletes the pod outright with a zero grace period, which the API
    // server honours even for a pod already terminating — a shorter grace always wins.
    async kill(handle, { graceful }) {
      const { namespace, name } = parseHandle(handle);
      // A hard kill is the reaper giving up on a run that never reported. Whatever the pod was
      // stuck on is about to be deleted with grace 0, so read it first.
      if (!graceful) await captureStatus(namespace, name);
      await deleteJob(namespace, name);
      if (!graceful) {
        const selector = encodeURIComponent(`job-name=${name}`);
        await call(
          "DELETE",
          `/api/v1/namespaces/${namespace}/pods?labelSelector=${selector}&gracePeriodSeconds=0`,
        );
      }
    },

    async inspect(handle) {
      try {
        const { namespace, name } = parseHandle(handle);
        return jobState(await call("GET", `${jobsPath(namespace)}/${name}`) as JobManifest);
      } catch (err) {
        // A missing Job cannot still run, including after the TTL controller collected it.
        // Keep transport/auth failures unknown: those are not evidence that anything stopped.
        if (err instanceof KubeError && err.status === 404) return "exited";
        diag.warn("kubernetes.inspect_failed", { handle, err: String(err) });
        return "unknown";
      }
    },

    capacity: kubernetesCapacity(opts, deps.fetch ?? globalThis.fetch, {
      holder: deps.leaseHolder,
    }),

    // The browser is a native sidecar, so a cluster that cannot run one cannot run it. A getter:
    // the agent form (`GET /v1/harnesses`) reads it synchronously, and until the API server has
    // been asked it is the optimistic answer — `browserRefusal` asks before any run is granted one.
    get supportsBrowser() {
      return sidecarsSupported !== false;
    },

    // No `controlUrl`: `ryph-runs` admits no ingress at all, so nothing the control plane could
    // dial reaches a run's pod. Its cancels ride the heartbeat's answer, then the reaper's kill.

    async browserRefusal(size, serviceCount) {
      let supported: boolean;
      try {
        supported = await probeSidecars();
      } catch (err) {
        // The launch will ask again and fail by name if the API server is still down; the browser
        // is not the place to refuse the run.
        diag.debug("kubernetes.version_probe_failed", { err: String(err) });
        return null;
      }
      if (!supported) {
        return `this cluster is older than Kubernetes 1.${SIDECAR_MINOR_FLOOR} and cannot run ` +
          "the browser as a native sidecar";
      }
      return browserStorageRefusal(size, serviceCount);
    },
  };
}

/**
 * The options, from the orchestrator's environment. Shared by both composition roots so the two
 * cannot read the same variables differently.
 *
 * In a pod the defaults are the pod's own: the API server from the env Kubernetes injects, the
 * token and CA from the mounted service account, and its namespace. `RYPH_K8S_API_URL` replaces
 * all of that with an address that authenticates for us — `kubectl proxy`, typically — and then no
 * token is sent: a service account token is for the API server alone, never for a URL from config.
 */
export function kubernetesOptionsFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
  serviceAccountDir = SERVICE_ACCOUNT_DIR,
): KubernetesOptions {
  const readIfPresent = (file: string): string | null => {
    try {
      return readFileSync(file, "utf8").trim() || null;
    } catch {
      return null;
    }
  };

  let apiUrl = env("RYPH_K8S_API_URL");
  let tokenFile: string | null = null;
  let caFile: string | null = null;
  if (apiUrl === undefined) {
    const host = env("KUBERNETES_SERVICE_HOST") ??
      fail(
        "RYPH_PROVISIONER=kubernetes outside a pod needs RYPH_K8S_API_URL " +
          "(e.g. a `kubectl proxy` address)",
      );
    const port = env("KUBERNETES_SERVICE_PORT") ?? "443";
    apiUrl = `https://${host.includes(":") ? `[${host}]` : host}:${port}`;
    tokenFile = `${serviceAccountDir}/token`;
    caFile = `${serviceAccountDir}/ca.crt`;
  } else if (!URL.canParse(apiUrl)) {
    fail(`RYPH_K8S_API_URL must be an absolute URL, got ${JSON.stringify(apiUrl)}`);
  }

  const namespace = env("RYPH_K8S_NAMESPACE") ??
    readIfPresent(`${serviceAccountDir}/namespace`) ??
    fail("RYPH_PROVISIONER=kubernetes needs RYPH_K8S_NAMESPACE");

  const rawUser = env("RYPH_K8S_RUN_USER") ?? DEFAULT_RUN_USER;
  const user = rawUser.split(":").map((part) => Number(part.trim()));
  if (
    user.length !== 2 ||
    user.some((n) => !Number.isInteger(n) || n <= 0 || n > 2 ** 31 - 1)
  ) {
    fail(
      `RYPH_K8S_RUN_USER must be uid:gid, both non-zero (a run is never root), ` +
        `got ${JSON.stringify(rawUser)}`,
    );
  }

  const seconds = (name: string): number | undefined => {
    const raw = env(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      fail(`${name} must be a whole number of seconds, got ${JSON.stringify(raw)}`);
    }
    return value;
  };

  return {
    apiUrl,
    namespace,
    tokenFile,
    caFile,
    serviceAccount: env("RYPH_K8S_SERVICE_ACCOUNT"),
    runtimeClass: env("RYPH_K8S_RUNTIME_CLASS"),
    checkComputeClass: env("RYPH_K8S_CHECK_COMPUTE_CLASS")?.trim() || undefined,
    runUser: { uid: user[0], gid: user[1] },
    workVolumeClass: env("RYPH_K8S_WORK_VOLUME_CLASS"),
    stopGraceSeconds: seconds("RYPH_K8S_STOP_GRACE_SECONDS"),
    ttlSecondsAfterFinished: seconds("RYPH_K8S_TTL_SECONDS"),
  };
}
