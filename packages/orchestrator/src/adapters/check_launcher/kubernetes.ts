// A Kubernetes `CheckLauncher`: one batch/v1 Job per suite generation, named by the spec, in the
// runs namespace and spoken to with the run provisioner's fetch-only API client. Shaped like the
// run's and the build's Jobs: created SUSPENDED, its Secret written owned by it, then released —
// see provisioner/kubernetes.ts on why the order has to be a fact.
//
// The pod, in order:
//   - init `clone`: fetches the head from the forge's git gateway into the `pristine` emptyDir,
//     proves HEAD is the recorded sha, prints the changed paths (scripts.ts). The ONLY container
//     that sees the one-shot git credential: its three `GIT_CONFIG_*` values come from the Secret
//     by `secretKeyRef`, on this container and no other
//   - init `setup-<i>`, one per setup step, in order, in `pristine`. Only when the image baked no
//     checkout of this repo: with one, setup runs in every check container instead (scripts.ts)
//   - the suite's services, as native sidecars (`sidecarContainer`, the run provisioner's, WITHOUT
//     its startupProbe), placed AFTER setup: they start once setup is done, and the checks start
//     with them. Each check's script waits for its services itself (SERVICE_WAIT_SECONDS) and
//     answers the platform's exit code when one never answers; a probe would hold every check
//     back until the deadline instead. A service the kubelet keeps restarting ends the suite at
//     once, as the platform's failure
//   - one regular container `check-<name>` per check, all started together, each mounting
//     `pristine` READ-ONLY and, with a memory pool, its own `pool-<name>` emptyDir read-write at
//     `/pool/<name>` and every other check's read-only beside it. With a baked checkout, each
//     moves the image's checkout to the head in its own writable layer and runs setup and the
//     check there; without one, each copies `pristine` to a `work-<name>` emptyDir of its own and
//     runs the check there
// Every container runs a platform-authored bash script as `command` — which overrides the image's
// ENTRYPOINT (`tini -s -- ryph-runner` on an image with the harness layer) — and reads its command
// from an env value. No container is wrapped in that tini: the image is usually the environment's
// baked image, which is below the harness layer and has no /opt/ryph (core/checks.ts `podImage`),
// so the script's bash is PID 1 and reaps only what it waits for; zombies a check leaves behind
// stay until the container ends. Nor is there any other reaper here (the docker launcher has
// docker's `--init`; a pod has no equivalent short of a shared process namespace).
//
// The verdict is `state.terminated.exitCode` of each check container, read from the pod status by
// `poll`. Nothing in the pod can write that value, and nothing here reads anything the pod says
// about itself except the clone's changed-paths lines, which the clone prints before any head
// code has run.
//
// The Job is the suite's DURABLE RECORD, as a build's is: `spec.name` is derived from the suite id
// and generation alone, so any replica polls it, reads its logs and discards it. What the Job
// holds after it ends is kept by `ttlSecondsAfterFinished` for the core to read; `discard` is
// what deletes it, once the rows are written.
//
// Two deadlines. The POD's `activeDeadlineSeconds` is the suite's: the kubelet kills what still
// runs and the pod stays, with every exit code and log, `status.reason: DeadlineExceeded`. The
// JOB's is later, a backstop only: at its deadline the Job controller DELETES the pod, and with it
// everything a verdict would be read from.
//
// A pod that ends for a reason of its own — evicted, preempted, its node gone
// (`DisruptionTarget`, `status.reason`) — is the platform's failure, never the head's: setup it
// cut short is `setup_failed` with no exit code, and every check it cut short exits
// CHECK_PLATFORM_EXIT with the reason. A check that had already exited keeps its own code. The
// one exception is an eviction for disk the head used (`ownDiskEviction`): one part of the pod
// over its own share, which failed on its own account with exit 1, or, past the clone, the pod
// over its total, which fails whatever it cut short with exit 1.
//
// What the pod is denied, as a run's is: no service account token, no service links, no retries
// (`backoffLimit: 0` — a second pod would be a second verdict), no root and no capabilities on any
// container of ours, the runtime default seccomp profile, and the deployment's RuntimeClass
// (gVisor on GKE). Its NetworkPolicy is `check-run-egress` (deploy/helm/ryph/templates/networkpolicies.yaml):
// DNS, the forge's git gateway and the egress proxy, and — unlike a run — no control plane at all.

import type {
  CheckContainerState,
  CheckInspection,
  CheckLauncher,
  CheckSpec,
} from "../../ports/check_launcher.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import { CHECK_PLATFORM_EXIT } from "../../core/checks.ts";
import { CHECK_POOL_EXIT } from "../../core/check_types.ts";
import { quantityBytes, SERVICE_EPHEMERAL_STORAGE } from "../../core/run_sizes.ts";
import {
  KubeError,
  type KubernetesApi,
  kubernetesApi,
  type KubernetesOptions,
  sidecarContainer,
  WORKLOAD_PRIORITY_CLASS,
} from "../provisioner/kubernetes.ts";
import {
  bakedCheckScript,
  CHECK_ENV,
  checkScript,
  cloneScript,
  POOL,
  PRISTINE,
  setupScript,
  WORK,
} from "./scripts.ts";
import {
  assertLaunchable,
  bakedTree,
  checkContainer,
  checkEnv,
  checkProxyEnv,
  checkShare,
  CLONE_CONTAINER,
  cloneEnv,
  lastBytes,
  LOG_TAIL_LINES,
  type MemoryPool,
  poolStopReason,
  setupContainer,
  setupEnv,
  timestamp,
} from "./shared.ts";

/** What `app.kubernetes.io/component` says on every check pod: what `check-run-egress`, the
 * forge's ingress and the egress proxy's ingress select. Never `agent-run`, whose policy reaches
 * the control plane. */
export const CHECK_COMPONENT = "check-run";

/** The lowest minor where restartable init containers are on by default. */
const SIDECAR_MINOR_FLOOR = 29;

/** How long a pod may wait for a node or an image before the suite is `unschedulable`. */
export const UNSCHEDULABLE_GRACE_MS = 10 * 60_000;

/** How old a still-SUSPENDED Job must be before `poll` takes it for a launcher that died in the
 * three calls between creating it and releasing it. A launch takes seconds. */
export const SUSPENDED_GRACE_MS = 2 * 60_000;

/** Waiting reasons that mean the pod cannot start a container, not that it is slow to. */
const STUCK_REASONS = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
  "ErrImageNeverPull",
  "CreateContainerConfigError",
  "CreateContainerError",
]);

/** How much of a container's log one request may carry. The kubelet serves the CURRENT log file
 * only (10Mi by default before it rotates), so this is a backstop, not the cap. */
const LOG_REQUEST_LIMIT_BYTES = 16 * 2 ** 20;
/** How many narrower asks a log read makes after one that hit the limit. */
const LOG_NARROWING_ATTEMPTS = 6;

/** How much later than the pod's deadline the Job's own falls: past the unschedulable grace, so
 * it only ever ends a pod nothing else has. */
export const JOB_DEADLINE_BACKSTOP_SECONDS = UNSCHEDULABLE_GRACE_MS / 1000 + 300;

/** Restarts after which a service sidecar is taken for one that will not come up. The kubelet
 * backs off 10 s, then 20 s: this is under a minute of a crashing service. */
export const SERVICE_RESTART_LIMIT = 2;

/** How early before the pod's deadline a container's end may be stamped and still be the
 * deadline's kill: timestamps are whole seconds. */
const DEADLINE_SLACK_MS = 1000;

// The Secret's key for each value: the two groups never collide, and each goes to its containers.
const cloneKey = (name: string) => `clone.${name}`;
const proxyKey = (name: string) => `proxy.${name}`;
const isNoProxy = (key: string) => key.toUpperCase() === "NO_PROXY";

type Labels = Record<string, string>;
type Container = Record<string, unknown>;

export interface CheckJobManifest {
  apiVersion: "batch/v1";
  kind: "Job";
  metadata: {
    name: string;
    namespace: string;
    labels: Labels;
    uid?: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
  };
  spec: Record<string, unknown>;
  status?: {
    conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
  };
}

export interface CheckSecretManifest {
  apiVersion: "v1";
  kind: "Secret";
  metadata: {
    name: string;
    namespace: string;
    labels: Labels;
    ownerReferences: Array<{ apiVersion: string; kind: string; name: string; uid: string }>;
  };
  type: "Opaque";
  stringData: Record<string, string>;
}

/** The labels on the Job, its pod and its Secret; `kubectl get job,pod -l ryph.check=<id>`. */
export function checkLabels(spec: Pick<CheckSpec, "suiteId" | "generation">): Labels {
  return {
    "app.kubernetes.io/managed-by": "ryph",
    "app.kubernetes.io/component": CHECK_COMPONENT,
    "ryph.check": spec.suiteId,
    "ryph.check-generation": String(spec.generation),
  };
}

/**
 * The Job one suite generation creates — suspended. Pure, and exported for the test: this is the
 * contract between the orchestrator and the check pod.
 *
 * `secretName` is the Secret this launch writes. It is the record's name plus a suffix fresh per
 * launch, not the record's name alone: a Job deleted by a failed launch takes its Secret with it
 * only once the garbage collector gets round to it, and a relaunch that reused the name would meet
 * the old one and fail on it.
 */
export function checkJobManifest(
  spec: CheckSpec,
  opts: KubernetesOptions,
  secretName: string,
): CheckJobManifest {
  assertLaunchable(spec);
  const labels = checkLabels(spec);
  const services = spec.services;
  const serviceNames = services.map((s) => s.name);
  const serviceBytes = services.length * quantityBytes(SERVICE_EPHEMERAL_STORAGE);
  const baked = bakedTree(spec) !== null;

  // The whole class for the init containers, which run one at a time; each check's share of it
  // for the check containers, which run together, asked and limited alike. Under gVisor (GKE
  // Sandbox) a container's own cpu and memory limits are not enforced: the one cap is the pod's,
  // and it is the SUM of its containers' limits. Share limits sum to the class, so the checks
  // still borrow above their shares freely, the pod is held to the class (plus the services'
  // own), and the pool watcher (sh/pool.sh) stops the check furthest over its share
  // before that cap kills the pod whole. Limits of the whole class would sum to N classes, past
  // the node. Under runc the kernel enforces each share, so a check over it is OOMKilled alone and
  // strict slices are the safe choice. Never pod-level resources (`spec.resources`): gVisor
  // enforces no cap at all on a pod that has them. Services add their own on top, as they do to
  // a run, and their disk comes out of the checks' — ephemeral storage is a pod budget. The kubelet
  // holds the pod to the sum of its containers' limits, volumes and writable layers together, and
  // looks at that before any one part's limit; an eviction for the sum names no part, so past the
  // clone it is the head's, unattributed (`ownDiskEviction`).
  //
  // A check's share is the same either way, and so is what it covers. A container's limit counts
  // its writable layer and its log: with a baked checkout, that layer IS the check's tree, every
  // file the move, setup or the check writes (overlay copy-up is whole-file, so a baked file
  // rewritten counts in full). Without one, the tree is the check's `work-<name>` volume, held to
  // its own `sizeLimit` below.
  const share = checkShare(spec.size, spec.checks.length, serviceBytes);
  const headMi = spec.size.ephemeralStorage === null
    ? null
    : Math.floor((quantityBytes(spec.size.ephemeralStorage) - serviceBytes) / 2 ** 20);
  const treeMi = headMi === null ? null : Math.floor(headMi / (spec.checks.length + 1));
  const whole: Record<string, string> = {
    ...(spec.size.cpu === null ? {} : { cpu: spec.size.cpu }),
    ...(spec.size.memory === null ? {} : { memory: spec.size.memory }),
    ...(headMi === null ? {} : { "ephemeral-storage": `${headMi}Mi` }),
  };
  const each: Record<string, string> = {
    ...(share.cpu === null ? {} : { cpu: share.cpu }),
    ...(share.memory === null ? {} : { memory: share.memory }),
    ...(share.ephemeralStorage === null ? {} : { "ephemeral-storage": share.ephemeralStorage }),
  };
  const pool: MemoryPool | null = spec.size.memory === null || share.memory === null
    ? null
    : { bytes: quantityBytes(spec.size.memory), shareBytes: quantityBytes(share.memory) };
  const sized = (r: Record<string, string>) =>
    Object.keys(r).length > 0 ? { resources: { requests: r, limits: r } } : {};

  const security = {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    runAsNonRoot: true,
    runAsUser: opts.runUser.uid,
    runAsGroup: opts.runUser.gid,
  };
  const fromSecret = (keys: string[], toKey: (k: string) => string) =>
    keys.map((key) => ({
      name: key,
      valueFrom: { secretKeyRef: { name: secretName, key: toKey(key) } },
    }));
  const plain = (vars: Record<string, string>) =>
    Object.entries(vars).map(([name, value]) => ({ name, value }));

  // The proxy URL carries the egress claim as its password, so it rides the Secret like a build's;
  // NO_PROXY is not a secret, and gains the service names (checkProxyEnv).
  const proxy = checkProxyEnv(spec.proxyEnv, serviceNames);
  const proxyEnv = [
    ...fromSecret(Object.keys(proxy).filter((k) => !isNoProxy(k)).sort(), proxyKey),
    ...plain(Object.fromEntries(Object.entries(proxy).filter(([k]) => isNoProxy(k)))),
  ];

  const clone: Container = {
    name: CLONE_CONTAINER,
    image: spec.image,
    command: ["/bin/bash", "-c", cloneScript()],
    env: [
      ...plain(cloneEnv(spec)),
      ...fromSecret(Object.keys(spec.clone.env).sort(), cloneKey),
    ],
    securityContext: security,
    ...sized(whole),
    volumeMounts: [{ name: "pristine", mountPath: PRISTINE }],
  };
  // With a baked checkout, setup runs in each check container (its env carries the steps).
  const setup: Container[] = baked ? [] : spec.setup.map((step, i) => ({
    name: setupContainer(i),
    image: spec.image,
    command: ["/bin/bash", "-c", setupScript()],
    env: [...plain(setupEnv(step, i)), ...proxyEnv],
    securityContext: security,
    ...sized(whole),
    volumeMounts: [{ name: "pristine", mountPath: PRISTINE }],
  }));
  const checks: Container[] = spec.checks.map((check) => ({
    name: checkContainer(check.name),
    image: spec.image,
    command: ["/bin/bash", "-c", baked ? bakedCheckScript() : checkScript()],
    env: [...plain(checkEnv(check, spec, pool)), ...proxyEnv],
    securityContext: security,
    ...sized(each),
    volumeMounts: [
      { name: "pristine", mountPath: PRISTINE, readOnly: true },
      // Its own pool directory read-write, and only its own: every other check's read-only.
      ...(pool === null ? [] : spec.checks.map((c) => ({
        name: poolVolume(c.name),
        mountPath: `${POOL}/${c.name}`,
        ...(c.name === check.name ? {} : { readOnly: true }),
      }))),
      ...(baked ? [] : [{ name: workVolume(check.name), mountPath: WORK }]),
    ],
  }));

  // Without a baked checkout, every tree is a whole copy: pristine, and one per check (`cp -a` of
  // it). The disk the services leave is split N+1 ways between them, so a tree too big for the
  // class evicts the pod naming the volume rather than filling the node's disk. With one,
  // pristine is the only volume and holds the clone alone (setup never writes there); it keeps
  // the same cap, and the checks' trees are held by their containers' limits.
  const treeLimit = treeMi === null ? {} : { sizeLimit: `${treeMi}Mi` };
  // The check pod's sidecars have no startupProbe: see the header.
  const sidecars = services.map((service) => {
    const { startupProbe: _probe, ...sidecar } = sidecarContainer(service);
    return sidecar;
  });

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: spec.name, namespace: opts.namespace, labels },
    spec: {
      suspend: true,
      backoffLimit: 0,
      // A backstop only: at the Job's deadline its pod is deleted, verdict and all (see the
      // header). The suite's own deadline is the pod's, below.
      activeDeadlineSeconds: spec.deadlineSeconds + JOB_DEADLINE_BACKSTOP_SECONDS,
      // Kept for the core to read after it ends; `discard` deletes it sooner, once rows are written.
      ttlSecondsAfterFinished: opts.ttlSecondsAfterFinished ?? 3600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          // The hard cap for a check that outlives its own `timeout`, and for a pod stuck in setup:
          // counted from the pod's start, with no orchestrator needed. The kubelet kills what
          // still runs and keeps the pod, so what had finished keeps its exit code and its log.
          activeDeadlineSeconds: spec.deadlineSeconds,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          // A check has nothing to finish gracefully; a discard should not wait on it.
          terminationGracePeriodSeconds: 10,
          // Above reserved capacity's placeholders, whatever the cluster's default priority.
          priorityClassName: WORKLOAD_PRIORITY_CLASS,
          ...(opts.serviceAccount ? { serviceAccountName: opts.serviceAccount } : {}),
          ...(opts.runtimeClass ? { runtimeClassName: opts.runtimeClass } : {}),
          // Nodes whose CPUs are all there when the pod starts (KubernetesOptions).
          ...(opts.checkComputeClass
            ? { nodeSelector: { "cloud.google.com/compute-class": opts.checkComputeClass } }
            : {}),
          // Pod-level, like a run's: the sidecars inherit it; the uid is per container, because
          // the sidecars are vendor images that start as root and drop privileges themselves.
          securityContext: {
            seccompProfile: { type: "RuntimeDefault" },
            fsGroup: opts.runUser.gid,
            fsGroupChangePolicy: "OnRootMismatch",
          },
          volumes: [
            { name: "pristine", emptyDir: treeLimit },
            // Each check's directory of the memory pool, a few bytes (an emptyDir is
            // world-writable, so the run user writes it as is). A small `sizeLimit`: head code
            // that fills its own ends the pod as that check's disk (`ownDiskEviction`), at
            // POOL_DIR_LIMIT, not at the pod's total.
            ...(pool === null ? [] : spec.checks.map((check) => ({
              name: poolVolume(check.name),
              emptyDir: { sizeLimit: POOL_DIR_LIMIT },
            }))),
            ...(baked ? [] : spec.checks.map((check) => ({
              name: workVolume(check.name),
              emptyDir: treeLimit,
            }))),
          ],
          // The declared name is the hostname, on loopback, as it is in a run's pod.
          ...(services.length > 0
            ? { hostAliases: [{ ip: "127.0.0.1", hostnames: serviceNames }] }
            : {}),
          initContainers: [clone, ...setup, ...sidecars],
          containers: checks,
        },
      },
    },
  };
}

function workVolume(check: string): string {
  return `work-${check}`;
}

/** One check's directory of the memory pool: written by its container alone. */
function poolVolume(check: string): string {
  return `pool-${check}`;
}

/** Each pool directory's `sizeLimit`: room for a line and its temp file, many times over. */
export const POOL_DIR_LIMIT = "64Ki";

/** The Secret: the clone's credential and the egress claim, owned by the Job so it dies with it. */
export function checkSecretManifest(
  spec: CheckSpec,
  opts: Pick<KubernetesOptions, "namespace">,
  jobUid: string,
  secretName: string,
): CheckSecretManifest {
  const proxy = checkProxyEnv(spec.proxyEnv, spec.services.map((s) => s.name));
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: secretName,
      namespace: opts.namespace,
      labels: checkLabels(spec),
      ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name: spec.name, uid: jobUid }],
    },
    type: "Opaque",
    stringData: {
      ...Object.fromEntries(Object.entries(spec.clone.env).map(([k, v]) => [cloneKey(k), v])),
      ...Object.fromEntries(
        Object.entries(proxy).filter(([k]) => !isNoProxy(k)).map(([k, v]) => [proxyKey(k), v]),
      ),
    },
  };
}

// The pod as the API server reports it, narrowed to what `readCheckPod` reads.
export interface ContainerStatus {
  name: string;
  restartCount?: number;
  state?: {
    waiting?: { reason?: string; message?: string };
    running?: { startedAt?: string };
    terminated?: {
      exitCode: number;
      reason?: string;
      message?: string;
      startedAt?: string;
      finishedAt?: string;
    };
  };
}
type Terminated = NonNullable<NonNullable<ContainerStatus["state"]>["terminated"]>;
export interface CheckPod {
  metadata?: { name?: string; creationTimestamp?: string };
  status?: {
    phase?: string;
    reason?: string;
    message?: string;
    startTime?: string;
    conditions?: Array<{
      type: string;
      status: string;
      reason?: string;
      message?: string;
      lastTransitionTime?: string;
    }>;
    initContainerStatuses?: ContainerStatus[];
    containerStatuses?: ContainerStatus[];
  };
}

/**
 * Why the pod itself ended, when that was not its containers' doing: a `DisruptionTarget`
 * condition (eviction, preemption, a node going away; `at` is when), or a Failed pod with a
 * `status.reason` of its own (Evicted, NodeLost, UnexpectedAdmissionError… — no `at`). Null for a
 * pod that runs, or ended because its containers did. The deadline is not one of these: it is
 * read on its own.
 */
export function podLevelEnd(pod: CheckPod): { why: string; at: number | null } | null {
  const status = pod.status ?? {};
  if (status.reason === "DeadlineExceeded") return null;
  const say = (reason?: string, message?: string) => [reason, message].filter(Boolean).join(": ");
  const disruption = (status.conditions ?? []).find((c) =>
    c.type === "DisruptionTarget" && c.status === "True"
  );
  if (disruption !== undefined) {
    const at = Date.parse(disruption.lastTransitionTime ?? "");
    return {
      why: `the check pod was stopped by the cluster (${
        say(disruption.reason, disruption.message) || "DisruptionTarget"
      })`,
      at: Number.isFinite(at) ? at : null,
    };
  }
  if (status.phase === "Failed" && status.reason) {
    return { why: `the check pod ended: ${say(status.reason, status.message)}`, at: null };
  }
  return null;
}

/** What the kubelet says when a container, or an emptyDir with a `sizeLimit`, goes over its own
 * limit, or the pod over the sum of its containers' (pkg/kubelet/eviction). Node pressure says
 * something else ("The node was low on resource"). */
const OWN_VOLUME_EVICTION = /Usage of EmptyDir volume "([^"]+)" exceeds the limit "([^"]+)"/;
const OWN_CONTAINER_EVICTION =
  /Container (\S+) exceeded its local ephemeral storage limit "([^"]+)"/;
const POD_TOTAL_EVICTION =
  /Pod ephemeral local storage usage exceeds the total limit of containers (\S+?)\.?(?:\s|$)/;

/**
 * The part of the pod the kubelet evicted it for, when the eviction names one: a container over
 * its ephemeral-storage limit, or a volume over its `sizeLimit` — `work-<check>` and `pool-<check>`
 * are that check's (`pool` set for the second), `pristine` is setup's (the checks mount it read-only). Or `pod`: the pod over the sum of its
 * containers' limits, which names no part but is still the head's, since every part of that sum
 * but the services' is the head's to fill (see `checkJobManifest`). Read from the pod's status
 * message and any `DisruptionTarget` condition, both the kubelet's words, never the pod's. Null
 * for every other ending, which stays the platform's. Pure, and exported for the test.
 *
 * With a baked checkout there are no `work-<check>` volumes and no setup containers: a check's
 * tree, and what its setup steps write, are its container's writable layer, so a check over its
 * share is named as its container (`check-<name>`). `pristine` then holds the clone alone, which
 * the clone's own failure covers.
 */
export function ownDiskEviction(
  pod: CheckPod,
):
  | { check: string; pool?: true; limit: string }
  | { setup: true; container: string | null; limit: string }
  | { pod: true; limit: string }
  | null {
  const status = pod.status ?? {};
  const messages = [
    status.reason === "Evicted" ? status.message : undefined,
    ...(status.conditions ?? [])
      .filter((c) => c.type === "DisruptionTarget" && c.status === "True")
      .map((c) => c.message),
  ].filter((m): m is string => typeof m === "string");
  for (const message of messages) {
    const volume = OWN_VOLUME_EVICTION.exec(message);
    if (volume !== null) {
      const [, name, limit] = volume;
      if (name === "pristine") return { setup: true, container: null, limit };
      if (name.startsWith("work-")) return { check: name.slice("work-".length), limit };
      // Only its own check's container writes a pool directory.
      if (name.startsWith("pool-")) {
        return { check: name.slice("pool-".length), pool: true, limit };
      }
    }
    const container = OWN_CONTAINER_EVICTION.exec(message);
    if (container !== null) {
      const [, name, limit] = container;
      if (name.startsWith("check-")) return { check: name.slice("check-".length), limit };
      if (/^setup-\d+$/.test(name)) return { setup: true, container: name, limit };
    }
    const total = POD_TOTAL_EVICTION.exec(message);
    if (total !== null) return { pod: true, limit: total[1] };
  }
  return null;
}

/** The reason a part that went over its disk share fails with. */
const overShare = (limit: string) => `used more disk than its share (${limit})`;
/** The reason every check a pod-wide disk eviction cut short fails with. */
const overTotal = (limit: string) =>
  `the suite's checks together used more disk than the class allows (${limit})`;
/** The reason a check fails with when its directory of the memory pool went over its
 * `sizeLimit`: only its own container writes there. */
const overPoolDir = (limit: string) =>
  `wrote more than ${limit} into its directory of the memory pool`;

/**
 * What a check Job and its pod say, in the port's words — or `lost` for a Job that ended with its
 * pod gone before anyone read it (its node was scaled away), and `stale` for a Job still
 * suspended long after its launch should have released it. Both leave nothing to read; the caller
 * deletes the Job and answers `gone`, so the core can launch again. Pure, and exported for the
 * test.
 *
 * The checks, the setup steps, the pod's deadline and whether there is a clone are read off the
 * Job's own pod template: a replica polling a Job it did not create knows nothing else about it.
 *
 * What an ending the head did not cause reads as (see the header):
 * - the pod's deadline: a check it killed exits with its code and reason `DeadlineExceeded`
 *   (timed out); a setup step it killed is `setup_failed` with exit 124; a clone it killed is
 *   `setup_failed` with no exit code
 * - a pod-level end (`podLevelEnd`), or a service the kubelet keeps restarting: setup it cut short
 *   is `setup_failed` with no exit code, and a check it cut short exits CHECK_PLATFORM_EXIT with
 *   the cause as its reason
 * - except an eviction for a part's own disk share (`ownDiskEviction`): the check it names exits
 *   1, and a setup step running when setup's tree went over its share is `setup_failed` with exit
 *   1; the other checks it cut short are still the platform's. The pod over its total is the
 *   same, naming no part: the setup step it cut short, or every check it cut short, exits 1. A
 *   clone over either stays the platform's, as every clone failure is
 * A container that had exited before the ending keeps its own exit code.
 */
export function readCheckJob(
  job: CheckJobManifest,
  pod: CheckPod | null,
  now: number,
): CheckInspection | { kind: "lost" } | { kind: "stale" } {
  const template = (job.spec.template as { spec?: Record<string, unknown> } | undefined)?.spec ??
    {};
  const names = (key: string) =>
    ((template[key] as Array<{ name: string }> | undefined) ?? []).map((c) => c.name);
  const checks = names("containers").filter((n) => n.startsWith("check-")).map((n) =>
    n.slice("check-".length)
  );
  const setupSteps = names("initContainers").filter((n) => /^setup-\d+$/.test(n)).length;
  const services = names("initContainers").filter((n) => n.startsWith("svc-"));

  const condition = (type: string) =>
    (job.status?.conditions ?? []).find((c) => c.type === type && c.status === "True");
  const failed = condition("Failed");
  const finished = failed !== undefined || condition("Complete") !== undefined;
  const jobDeadline = failed?.reason === "DeadlineExceeded";
  const created = Date.parse(job.metadata.creationTimestamp ?? "");

  if ((job.spec as { suspend?: boolean }).suspend === true) {
    return Number.isFinite(created) && now - created > SUSPENDED_GRACE_MS
      ? { kind: "stale" }
      : { kind: "pending", cloneDone: false, why: "the job is being released" };
  }

  const killed = (reason: string): CheckContainerState => ({
    state: "exited",
    exitCode: 137,
    startedAt: null,
    finishedAt: null,
    reason,
  });
  const platformExit = (
    why: string,
    ended?: Terminated,
  ): CheckContainerState => ({
    state: "exited",
    exitCode: CHECK_PLATFORM_EXIT,
    startedAt: timestamp(ended?.startedAt),
    finishedAt: timestamp(ended?.finishedAt),
    reason: why,
  });

  if (pod === null) {
    // Only the Job's backstop deadline deletes the pod: a pod that got that far never ended by
    // its own, and every check it held was killed by it.
    if (jobDeadline) {
      return {
        kind: "checks",
        checks: Object.fromEntries(checks.map((c) => [c, killed("DeadlineExceeded")])),
        done: true,
      };
    }
    if (finished) return { kind: "lost" };
    return { kind: "pending", cloneDone: false, why: "waiting for a pod" };
  }

  const init = new Map((pod.status?.initContainerStatuses ?? []).map((s) => [s.name, s]));
  const main = new Map((pod.status?.containerStatuses ?? []).map((s) => [s.name, s]));
  const say = (w?: { reason?: string; message?: string }) =>
    [w?.reason, w?.message].filter(Boolean).join(": ");
  const clone = init.get(CLONE_CONTAINER)?.state?.terminated;
  const cloneDone = clone?.exitCode === 0;
  const setupNames = Array.from({ length: setupSteps }, (_, i) => setupContainer(i));

  // A pod that cannot get a node or an image is waiting on something that is not coming. The
  // grace runs from the pod's creation or the last clone or setup step to end, whichever is later:
  // a service's image is pulled, and a check's container created, only once setup is done, so a
  // pull that fails after a long setup gets a grace of its own rather than none.
  const marks = [
    pod.metadata?.creationTimestamp,
    ...[CLONE_CONTAINER, ...setupNames].map((n) => init.get(n)?.state?.terminated?.finishedAt),
  ].map((t) => Date.parse(t ?? "")).filter(Number.isFinite);
  const pastGrace = marks.length > 0 && now - Math.max(...marks) > UNSCHEDULABLE_GRACE_MS;
  const stuck = [...init.values(), ...main.values()].find((s) =>
    STUCK_REASONS.has(s.state?.waiting?.reason ?? "")
  );
  if (stuck) {
    const why = `${stuck.name}: ${say(stuck.state?.waiting)}`;
    return pastGrace ? { kind: "unschedulable", why } : { kind: "pending", cloneDone, why };
  }
  const scheduled = (pod.status?.conditions ?? []).find((c) => c.type === "PodScheduled");
  if (scheduled?.status === "False") {
    const why = say(scheduled) || "waiting for a node";
    return pastGrace && scheduled.reason === "Unschedulable"
      ? { kind: "unschedulable", why: null, detail: why }
      : { kind: "pending", cloneDone, why };
  }

  // The deadline: the pod's own, or (its pod still there) the Job's backstop.
  const deadline = pod.status?.reason === "DeadlineExceeded" || jobDeadline;
  const podDeadlineS = template.activeDeadlineSeconds;
  const podStart = Date.parse(pod.status?.startTime ?? "");
  const deadlineAt = typeof podDeadlineS === "number" && Number.isFinite(podStart)
    ? podStart + podDeadlineS * 1000
    : null;
  /** Whether a container that ended non-zero was ended by `at` (or, unknown when, looks killed). */
  const endedBy = (t: Terminated, at: number | null) => {
    if (t.exitCode === 0) return false;
    if (at === null) return t.exitCode >= 128;
    const finished = Date.parse(t.finishedAt ?? "");
    return !Number.isFinite(finished) || finished >= at - DEADLINE_SLACK_MS;
  };
  const byDeadline = (t: Terminated) => deadline && endedBy(t, deadlineAt);
  const podEnd = podLevelEnd(pod);
  // A container the kubelet lost track of is never its own failure.
  const byPlatform = (t: Terminated) =>
    t.reason === "ContainerStatusUnknown" || (podEnd !== null && endedBy(t, podEnd.at));
  const cutShort = (step: string) =>
    `${step} was cut short: ${podEnd?.why ?? "the kubelet lost its container"}`;

  if (clone !== undefined && clone.exitCode !== 0) {
    const platform = byPlatform(clone) || byDeadline(clone);
    return {
      kind: "setup_failed",
      cloneDone: false,
      step: "clone",
      exitCode: platform ? null : clone.exitCode,
      why: byPlatform(clone)
        ? cutShort("the clone")
        : byDeadline(clone)
        ? "the clone ran past the suite's deadline"
        : `the clone exited ${clone.exitCode}`,
    };
  }
  const ownDisk = podEnd === null ? null : ownDiskEviction(pod);
  /** A setup step that failed because setup's tree, or the step, went over its disk share — or
   * the pod over its total while the step ran: past the clone, only the step was writing. */
  const setupOverShare = (i: number) =>
    ownDisk !== null && ("pod" in ownDisk ||
        ("setup" in ownDisk &&
          (ownDisk.container === null || ownDisk.container === setupContainer(i))))
      ? {
        kind: "setup_failed" as const,
        cloneDone,
        step: i,
        exitCode: 1,
        why: `setup step ${i + 1} ${
          "pod" in ownDisk
            ? `took the pod past its disk total (${ownDisk.limit})`
            : overShare(ownDisk.limit)
        }`,
      }
      : null;
  for (let i = 0; i < setupSteps; i++) {
    const step = init.get(setupContainer(i))?.state?.terminated;
    if (step !== undefined && step.exitCode !== 0) {
      const own = setupOverShare(i);
      if (own !== null) return own;
      const platform = byPlatform(step);
      const late = !platform && byDeadline(step);
      return {
        kind: "setup_failed",
        cloneDone,
        step: i,
        exitCode: platform ? null : late ? 124 : step.exitCode,
        why: platform
          ? cutShort(`setup step ${i + 1}`)
          : late
          ? `setup step ${i + 1} ran past the suite's deadline`
          : `setup step ${i + 1} exited ${step.exitCode}`,
      };
    }
  }
  const initDone = cloneDone &&
    setupNames.every((n) => init.get(n)?.state?.terminated?.exitCode === 0);
  const podEnded = pod.status?.phase === "Failed" || pod.status?.phase === "Succeeded";
  if (!initDone) {
    if (deadline || podEnded || podEnd !== null) {
      // Ended before setup did. Nothing ran; nothing can.
      const step = cloneDone ? firstUnfinished(init, setupSteps) : "clone";
      const own = step === "clone" ? null : setupOverShare(step);
      if (own !== null) return own;
      if (deadline && podEnd === null) {
        return step === "clone"
          ? {
            kind: "setup_failed",
            cloneDone,
            step,
            exitCode: null,
            why: "the clone ran past the suite's deadline",
          }
          : {
            kind: "setup_failed",
            cloneDone,
            step,
            exitCode: 124,
            why: `setup step ${step + 1} ran past the suite's deadline`,
          };
      }
      return {
        kind: "setup_failed",
        cloneDone,
        step,
        exitCode: null,
        why: podEnd !== null
          ? `setup was cut short: ${podEnd.why}`
          : `the check pod ended (${pod.status?.phase ?? "no phase"}) before setup finished`,
      };
    }
    const running = [CLONE_CONTAINER, ...setupNames]
      .find((n) => init.get(n)?.state?.terminated === undefined);
    const waiting = running === undefined ? undefined : init.get(running)?.state?.waiting;
    const started = running !== undefined && init.get(running)?.state?.running !== undefined;
    return {
      kind: "pending",
      cloneDone,
      why: running === undefined ? null : `${running}${waiting ? ` (${say(waiting)})` : ""}`,
      ...(started
        ? {
          running: running === CLONE_CONTAINER
            ? "clone" as const
            : Number(running.slice("setup-".length)),
        }
        : {}),
    };
  }

  // A service the kubelet keeps restarting will not come up: every check still waiting on it,
  // or running against it, is the platform's failure now rather than at SERVICE_WAIT_SECONDS.
  const crashing = services.map((name) => init.get(name)).find((s) =>
    (s?.restartCount ?? 0) >= SERVICE_RESTART_LIMIT
  );
  const serviceDown = crashing === undefined
    ? null
    : `service ${
      crashing.name.slice("svc-".length)
    } keeps failing (restarted ${crashing.restartCount} times${
      crashing.state?.waiting?.reason ? `, ${crashing.state.waiting.reason}` : ""
    })`;

  // The pod over its total: no one check to blame, but the head's disk all the same (see
  // `ownDiskEviction`), so every check it cut short failed on the suite's own account.
  const overPodTotal = ownDisk !== null && "pod" in ownDisk ? overTotal(ownDisk.limit) : null;
  const states: Record<string, CheckContainerState> = {};
  for (const check of checks) {
    const status = main.get(checkContainer(check))?.state;
    const terminated = status?.terminated;
    const overDisk = ownDisk !== null && "check" in ownDisk && ownDisk.check === check
      ? (ownDisk.pool ? overPoolDir(ownDisk.limit) : overShare(ownDisk.limit))
      : overPodTotal !== null && (terminated === undefined || byPlatform(terminated))
      ? overPodTotal
      : null;
    if (overDisk !== null) {
      // Went over its share: its own failure, whatever the kill left as an exit code.
      states[check] = {
        state: "exited",
        exitCode: 1,
        startedAt: timestamp(terminated?.startedAt ?? status?.running?.startedAt),
        finishedAt: timestamp(terminated?.finishedAt),
        reason: overDisk,
      };
    } else if (terminated !== undefined) {
      states[check] = byPlatform(terminated)
        ? platformExit(cutShort(`check ${check}`), terminated)
        : {
          state: "exited",
          exitCode: terminated.exitCode,
          startedAt: timestamp(terminated.startedAt),
          finishedAt: timestamp(terminated.finishedAt),
          reason: byDeadline(terminated)
            ? "DeadlineExceeded"
            : terminated.exitCode === CHECK_POOL_EXIT
            ? poolStopReason(templatePool(template, check))
            : meaningfulReason(terminated.reason),
        };
    } else if (deadline && podEnd === null) {
      // Killed at the deadline with no exit to show yet: timed out, never left waiting.
      states[check] = killed("DeadlineExceeded");
    } else if (podEnd !== null) {
      states[check] = platformExit(cutShort(`check ${check}`));
    } else if (podEnded) {
      states[check] = platformExit(`the check pod ended (${pod.status?.phase}) without its exit`);
    } else if (serviceDown !== null) {
      states[check] = platformExit(serviceDown);
    } else if (status?.running !== undefined) {
      states[check] = { state: "running", startedAt: timestamp(status.running.startedAt) };
    } else {
      states[check] = { state: "waiting" };
    }
  }
  return {
    kind: "checks",
    checks: states,
    done: Object.values(states).every((s) => s.state === "exited"),
  };
}

/** The pool and share a check container was launched with, read off the Job's own template (the
 * env the launcher set): null when it has none, or none that reads. */
function templatePool(template: Record<string, unknown>, check: string): MemoryPool | null {
  const container = (template.containers as Array<Record<string, unknown>> | undefined)
    ?.find((c) => c.name === checkContainer(check));
  const env = (container?.env as Array<{ name: string; value?: string }> | undefined) ?? [];
  const value = (name: string) => Number(env.find((e) => e.name === name)?.value ?? NaN);
  const bytes = value(CHECK_ENV.poolBytes);
  const shareBytes = value(CHECK_ENV.shareBytes);
  return bytes > 0 && shareBytes > 0 ? { bytes, shareBytes } : null;
}

function firstUnfinished(init: Map<string, ContainerStatus>, setupSteps: number): number {
  for (let i = 0; i < setupSteps; i++) {
    if (init.get(setupContainer(i))?.state?.terminated?.exitCode !== 0) return i;
  }
  return Math.max(0, setupSteps - 1);
}

/** The kubelet's reason for an exit, where it says more than the code does. */
function meaningfulReason(reason: string | undefined): string | null {
  return reason === undefined || reason === "Completed" || reason === "Error" ? null : reason;
}

export function kubernetesCheckLauncher(
  opts: KubernetesOptions,
  diag: Diagnostics,
  deps: { fetch?: typeof fetch; now?: () => number } = {},
): CheckLauncher {
  const api: KubernetesApi = kubernetesApi(opts, deps.fetch ?? globalThis.fetch, {
    requestTimeoutMs: 60_000,
  });
  const now = deps.now ?? Date.now;
  const ns = opts.namespace;
  const jobsPath = `/apis/batch/v1/namespaces/${ns}/jobs`;
  const podsPath = `/api/v1/namespaces/${ns}/pods`;

  let sidecarsSupported: boolean | null = null;
  /** The run provisioner's refusal, for its reason: below 1.29 a "sidecar" runs to completion
   * and the checks never start. Asked once. */
  async function refuseIfNoSidecars(): Promise<void> {
    if (sidecarsSupported === null) {
      const version = await api.call("GET", "/version") as { major?: string; minor?: string };
      const major = Number.parseInt(String(version?.major ?? ""), 10);
      const minor = Number.parseInt(String(version?.minor ?? ""), 10);
      sidecarsSupported = Number.isFinite(major) && Number.isFinite(minor) &&
        (major > 1 || (major === 1 && minor >= SIDECAR_MINOR_FLOOR));
    }
    if (!sidecarsSupported) {
      throw new Error(
        `this check suite declares services, which need native sidecars — Kubernetes ` +
          `1.${SIDECAR_MINOR_FLOOR} or newer. This cluster is older.`,
      );
    }
  }

  /**
   * Deletes a Job by name — and, given its uid, only THAT Job. A relaunch reuses the name, so a
   * call that saw one Job (a launch cleaning up after itself, a poll that found a Job lost) and
   * deletes a moment later could otherwise take its successor. The API server answers a uid that
   * no longer matches with 409: the Job this call meant is gone already, which is what it wanted.
   * The Job's Secret is owned by it and goes with it; nothing deletes a Secret by name.
   */
  async function deleteJob(name: string, uid?: string): Promise<void> {
    try {
      await api.call(
        "DELETE",
        `${jobsPath}/${name}?propagationPolicy=Background`,
        uid === undefined ? undefined : {
          apiVersion: "v1",
          kind: "DeleteOptions",
          propagationPolicy: "Background",
          preconditions: { uid },
        },
      );
    } catch (err) {
      const gone = err instanceof KubeError &&
        (err.status === 404 || (uid !== undefined && err.status === 409));
      if (!gone) throw err;
    }
  }

  /**
   * The Job's pod — the newest, though `backoffLimit: 0` means there is only ever one. Selected by
   * the Job's uid, not its name: a relaunch reuses the name, and the pod of the Job it replaced
   * can still be terminating under the same `job-name` label.
   */
  async function podOf(job: CheckJobManifest): Promise<CheckPod | null> {
    const uid = job.metadata.uid;
    if (!uid) throw new Error(`check job ${job.metadata.name} has no uid`);
    const selector = encodeURIComponent(`batch.kubernetes.io/controller-uid=${uid}`);
    const list = await api.call("GET", `${podsPath}?labelSelector=${selector}`) as {
      items?: CheckPod[];
    };
    const pods = (list?.items ?? []).filter((p) => p.metadata?.name);
    pods.sort((a, b) =>
      Date.parse(a.metadata?.creationTimestamp ?? "") -
      Date.parse(b.metadata?.creationTimestamp ?? "")
    );
    return pods.at(-1) ?? null;
  }

  return {
    kind: "kubernetes",

    async launch(spec: CheckSpec): Promise<void> {
      if (spec.services.length > 0) await refuseIfNoSidecars();
      if (spec.size.workVolume !== null) {
        diag.debug("check_launcher.kubernetes.work_volume_unapplied", {
          suiteId: spec.suiteId,
          sizeClass: spec.size.name,
          detail: "check trees live on emptyDir or the image's own layer; a size class's work " +
            "volume is not applied",
        });
      }
      const nonce = crypto.getRandomValues(new Uint8Array(4));
      const secretName = `${spec.name}-${
        Array.from(nonce, (b) => b.toString(16).padStart(2, "0")).join("")
      }`;
      const job = checkJobManifest(spec, opts, secretName);
      let uid: string | undefined;
      try {
        const created = await api.call("POST", jobsPath, job) as CheckJobManifest;
        uid = created?.metadata?.uid;
      } catch (err) {
        if (!(err instanceof KubeError && err.status === 409)) throw err;
        // Launched already. Released, it is the record and this is success; still suspended, its
        // launcher died before the release and its Secret may not exist — it goes, and the core
        // launches again once it has.
        const existing = await api.call("GET", `${jobsPath}/${spec.name}`) as CheckJobManifest;
        const suspended = (existing?.spec as { suspend?: boolean } | undefined)?.suspend === true;
        if (!suspended && !existing?.metadata?.deletionTimestamp) {
          diag.debug("check_launcher.kubernetes.already_launched", { job: `${ns}/${spec.name}` });
          return;
        }
        if (suspended) await deleteJob(spec.name, existing?.metadata?.uid);
        throw new Error(
          `check job ${ns}/${spec.name} was left half-launched or is being deleted; it is being ` +
            "removed, and the suite can be launched again once it is gone",
        );
      }
      try {
        if (!uid) throw new Error(`kubernetes created job ${spec.name} but returned no uid`);
        await api.call(
          "POST",
          `/api/v1/namespaces/${ns}/secrets`,
          checkSecretManifest(spec, opts, uid, secretName),
        );
        // The uid in a patch is a precondition too: this releases the Job it created, or none.
        await api.call(
          "PATCH",
          `${jobsPath}/${spec.name}`,
          { metadata: { uid }, spec: { suspend: false } },
          "application/merge-patch+json",
        );
      } catch (err) {
        // Only the Job this launch created. With no uid there is nothing to hold the delete to,
        // and a Job by this name may by now be another launch's: a poll finds it stale instead.
        if (uid !== undefined) {
          await deleteJob(spec.name, uid).catch((cleanupErr) =>
            diag.warn("check_launcher.kubernetes.launch_cleanup_failed", {
              job: spec.name,
              err: String(cleanupErr),
            })
          );
        }
        throw err;
      }
      diag.debug("check_launcher.kubernetes.launched", {
        suiteId: spec.suiteId,
        generation: spec.generation,
        job: `${ns}/${spec.name}`,
        checks: spec.checks.length,
        baked: spec.bakedCheckout,
        services: spec.services.map((s) => s.name),
        runtimeClass: opts.runtimeClass ?? "default",
        computeClass: opts.checkComputeClass ?? "default",
      });
    },

    async poll(name: string): Promise<CheckInspection> {
      let job: CheckJobManifest;
      try {
        job = await api.call("GET", `${jobsPath}/${name}`) as CheckJobManifest;
      } catch (err) {
        // 404 is an answer; anything else is not one, and must decide nothing.
        if (err instanceof KubeError && err.status === 404) return { kind: "gone" };
        return { kind: "unknown", why: err instanceof Error ? err.message : String(err) };
      }
      try {
        if (job?.metadata?.deletionTimestamp) return { kind: "gone" };
        const pod = await podOf(job);
        const read = readCheckJob(job, pod, now());
        if (read.kind === "lost" || read.kind === "stale") {
          diag.warn(`check_launcher.kubernetes.${read.kind}`, {
            job: `${ns}/${name}`,
            detail: read.kind === "lost"
              ? "the job ended and its pod is gone, with its exit codes; it goes, to be run again"
              : "the job was never released; its launcher died mid-launch",
          });
          await deleteJob(name, job.metadata.uid);
          return { kind: "gone" };
        }
        return read;
      } catch (err) {
        return { kind: "unknown", why: err instanceof Error ? err.message : String(err) };
      }
    },

    async logs(name: string, container: string, maxBytes: number): Promise<string | null> {
      try {
        const job = await api.call("GET", `${jobsPath}/${name}`) as CheckJobManifest;
        const pod = await podOf(job);
        const podName = pod?.metadata?.name;
        if (!podName) return null;
        // `limitBytes` counts from the START of the tail window, so a window over the limit loses
        // its end, which is the part that matters. Such a window is asked again, narrower, until
        // it fits: halved each time from the lines that did fit.
        let tail = LOG_TAIL_LINES;
        for (let attempt = 0;; attempt++) {
          const text = await api.text(
            "GET",
            `${podsPath}/${podName}/log?container=${encodeURIComponent(container)}` +
              `&tailLines=${tail}&limitBytes=${LOG_REQUEST_LIMIT_BYTES}`,
          );
          const cut = new TextEncoder().encode(text).length >= LOG_REQUEST_LIMIT_BYTES;
          if (!cut || tail === 1 || attempt === LOG_NARROWING_ATTEMPTS) {
            return lastBytes(text, maxBytes);
          }
          const fitted = text.split("\n").length - 1;
          tail = Math.max(1, Math.min(tail - 1, Math.floor(fitted / 2)));
        }
      } catch (err) {
        if (!(err instanceof KubeError && (err.status === 404 || err.status === 400))) {
          diag.warn("check_launcher.kubernetes.logs_failed", {
            job: name,
            container,
            err: String(err),
          });
        }
        return null;
      }
    },

    async discard(name: string): Promise<void> {
      await deleteJob(name);
      diag.debug("check_launcher.kubernetes.discarded", { job: `${ns}/${name}` });
    },

    async list(): Promise<string[]> {
      const selector = encodeURIComponent(`app.kubernetes.io/component=${CHECK_COMPONENT}`);
      const jobs = await api.call("GET", `${jobsPath}?labelSelector=${selector}`) as {
        items?: Array<{ metadata?: { name?: string } }>;
      };
      return (jobs?.items ?? []).map((j) => j.metadata?.name).filter((n): n is string => !!n);
    },
  };
}
