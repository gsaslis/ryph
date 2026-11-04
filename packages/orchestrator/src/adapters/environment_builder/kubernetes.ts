// The kubernetes `EnvironmentBuilder`: one batch/v1 Job per build, in its own namespace
// (`ryph-builds`), running rootless BuildKit under the deployment's sandbox runtime class, and
// pushing to the environments registry (`RYPH_ENV_REGISTRY`, `…/ryph-envs` on GKE). Spoken to with
// the same fetch-only API client as the run provisioner, and shaped like it: created suspended, its
// Secret written owned by it, then released.
//
// The pod, in order:
//   - init container `clone`, on the deployment's universal image (it has git and bash): writes
//     the generated outer Dockerfile and clones every checkout, with the build's git credential
//     from the Secret. It holds the credential; BuildKit never does
//   - container `buildkit`, `moby/buildkit:*-rootless`: starts ONE buildkitd (see
//     `buildkitdLines`, and why upstream's `buildctl-daemonless.sh` costs this build its whole
//     base image on every pass), then builds the repo's `.ryph/Dockerfile` when there is one and
//     pushes it as the machine, builds the outer file on top of it and pushes the environment and
//     its baked stage, then exports the toolchain record. The digests come from
//     `buildctl --metadata-file`, each printed on a line of its own for this adapter to read back
//     from the pod log
// A re-layer (`relayerFrom`) clones nothing and builds the re-layer file on the image it names. A
// warm build (`warmFrom`) clones, builds no machine and uses no layer cache: the warm file, on the
// earlier build's baked image.
//
// The Job is also this backend's DURABLE RECORD of a build, which is what `adopt` rests on:
// `buildJobName` is derived from the environment id alone, so a control plane that never started
// this build — a replacement pod after a rollout, say — can still find it, watch it to its end and
// read its result out of the pod log, exactly as the process that created it would have. Parsing
// `@@ryph-result` lines works no differently on a Job that finished an hour ago than on one
// finishing now, so the only thing adoption needs is for the Job to still be there: see
// DEFAULT_TTL_SECONDS.
//
// Invariants:
// - a build ends with its Job deleted — on `discard`, which the core calls once it has WRITTEN
//   the build's row, and never when the log is merely read. Reading the log is not what makes a
//   result durable, and a Job deleted a moment before the row was saved is a successful build
//   that the next control plane finds no trace of. `activeDeadlineSeconds` and
//   `ttlSecondsAfterFinished` are the backstops for a control plane that died mid-build
// - a default-branch build and a branch build are two identities (`serviceAccount` and
//   `branchServiceAccount`) pushing to two registries: the branch one cannot write the shared
//   registry, where the default branch's images and every layer cache live. See below for why
//   that, and not the export flag, is the boundary
// - no API token in the pod (`automountServiceAccountToken: false`), no service links. The
//   service accounts (`ryph-builder`, `ryph-branch-builder`) are there for Workload Identity alone
// - the result is read ONLY from a line that starts with `@@ryph-result`, and every key is printed
//   exactly once, so a key seen twice fails the build. BuildKit's plain progress prefixes every
//   line a build step prints with `#<n> <seconds>`, so a step's OUTPUT cannot print one. A step
//   that reaches past its output can: on kubernetes, without a process sandbox, a RUN step shares
//   the script's user and could write to the pod's log through /proc or fill `/work/out`. That is
//   that build's own result at worst (a duplicate fails it; a digest reported instead is only
//   what its own row records), and why retention never trusts a recorded digest to be the row's
//   alone. Cloud Build reads the step's output, which no step can write
// - the layer cache a build WRITES is `cacheScope.write`'s ref and no other, and a branch build
//   writes none
// - what a build pushed is removed by the control plane, as its own Google identity, from an
//   Artifact Registry it may delete in (artifact_registry.ts); a build pod's identity never can
//
// MEASURED on GKE Autopilot under gVisor: rootless BuildKit does start with the
// seccomp and AppArmor profiles it needs unconfined, and does build — but only once its
// snapshotter is `native` (see DEFAULT_SNAPSHOTTER; the default overlay dies on the first
// `COPY --from`). The shape below is upstream's rootless Job (examples/kubernetes/job.rootless.yaml), with
// `--oci-worker-no-process-sandbox`, which is also why the push credential is reachable from a
// RUN step here: without the process sandbox a step shares buildkitd's user and pod network, so
// the Workload Identity token is one metadata request away. That is why a branch build runs as an
// identity of its own, which can read the shared registry and write only the branch one: a branch
// that steals its token can overwrite branch images (which runs launch by digest, so nothing is
// redirected) and nothing a default-branch build reads. A default-branch build's steps can still
// reach its own token — the trusted ref's, which may write any subject's shared cache. See
// docs/environment-builders.md for that residue and the Cloud Build alternative.

import type {
  AdoptResult,
  AdoptSpec,
  BuildResult,
  BuildSpec,
  EnvironmentBuilder,
} from "../../ports/environment_builder.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import { quantityBytes, type RunSize } from "../../core/run_sizes.ts";
import {
  KubeError,
  type KubernetesApi,
  kubernetesApi,
  type KubernetesConnection,
  WORKLOAD_PRIORITY_CLASS,
} from "../provisioner/kubernetes.ts";
import {
  assertBuildable,
  BuildLog,
  failureLine,
  logTail,
  proxyBuildArgs,
  safeName,
} from "./dockerfile.ts";
import {
  BUILDKIT_UID,
  buildScript,
  initArgs,
  initScript,
  readScriptResult,
  type ScriptOptions,
  STEP_NO_PROXY,
  WORK,
} from "./buildkit_script.ts";
import { artifactRegistryCleaner } from "./artifact_registry.ts";
import { metadataToken } from "./google_api.ts";

// The script is shared with the Cloud Build builder; its tests reach it through here as before.
export {
  buildLines,
  buildScript,
  credentialHelper,
  imageRepository,
  initScript,
  resultLines,
} from "./buildkit_script.ts";

/**
 * The snapshotter buildkitd uses for its own layers, MEASURED on GKE Autopilot under gVisor.
 *
 * Left to itself (`auto`) the rootless worker picks an overlay: rootless `overlayfs` where the
 * kernel allows it, else `fuse-overlayfs`. Neither survives here. The first real build on
 * GKE Autopilot died on its `COPY --from` with
 *
 *   mount callback failed on /run/user/1000/containerd-mount…: mkdir …/etc:
 *   transport endpoint is not connected
 *
 * which is a FUSE mount whose daemon is gone — gVisor's FUSE is not what fuse-overlayfs needs.
 * `native` uses plain directories and full copies instead of any overlay or FUSE, so it works
 * inside the sandbox. The price is disk and time: every layer is copied rather than stacked,
 * which is why buildkitd's state lives on the build's work volume and not the pod's 10Gi of
 * ephemeral storage (Autopilot's cap, which a build would otherwise hit on its own).
 * `RYPH_ENV_BUILDKIT_SNAPSHOTTER` overrides it for a deployment whose sandbox is not gVisor.
 */
const DEFAULT_SNAPSHOTTER = "native";

/**
 * How long a FINISHED Job sticks around before kubernetes collects it — the window in which its
 * result can still be adopted.
 *
 * A Job is deleted as soon as its build's row is written (`discard`), so this only applies when
 * nobody got that far. MEASURED on a GKE deployment at the old value of 300 s:
 * two builds completed at 21:00, the control-plane pod was replaced at 21:18, and by the time the
 * new one looked there was nothing left to look at — both rows sat `building` for ever and wedged
 * the whole queue behind them. Five minutes is not a window, it is a coincidence.
 *
 * An hour is. A rollout plus a boot is a minute or two, and a stranded row is adopted within one
 * reaper tick of that; an hour leaves room for a control plane that crash-loops or an operator who
 * has to be woken up. The price is object retention: a finished Job whose result nobody comes for
 * holds its pod — and with it the ephemeral PersistentVolumeClaim the build's work volume is,
 * which the namespace's quota counts — for an hour instead of five minutes. Bounded by the build
 * concurrency, and a far smaller bill than a wedged queue.
 *
 * What this hour does NOT buy is the build's RESULT surviving its node. The result is read out of
 * the pod's log, and a pod goes when its node does — which on GKE is a build node scaled down
 * minutes after the build that asked for it finished. The Job is still there and still says
 * `Complete`, so adoption knows the build succeeded and cannot learn what it pushed; `finish`
 * says exactly that rather than blaming the build (see `podsSeen`), and the row is built again.
 */
const DEFAULT_TTL_SECONDS = 3600;

/**
 * Why the kubernetes builder refuses to build with no runtime class. A build runs a branch's
 * `.ryph/Dockerfile` and `setup.yml`, which an agent can write, and rootless BuildKit needs seccomp
 * and AppArmor unconfined to make its user namespace: without a sandboxing runtime every RUN step
 * has the node kernel's full syscall surface, and a user-namespace kernel bug is root on the node,
 * with every run Secret scheduled there.
 */
export const UNSANDBOXED_BUILDS_REFUSED =
  "the kubernetes environment builder needs a sandboxing RuntimeClass for build pods " +
  "(RYPH_ENV_BUILD_RUNTIME_CLASS, else RYPH_K8S_RUNTIME_CLASS; gvisor, say): a build runs " +
  "repositories' Dockerfiles with seccomp and AppArmor unconfined, and without one that is on the " +
  "node's own kernel. Set one, or on a laptop cluster only RYPH_ENV_BUILD_ALLOW_UNSANDBOXED=on";

/** Upstream's rootless release, pinned. `RYPH_ENV_BUILDKIT_IMAGE` overrides it. */
export const DEFAULT_BUILDKIT_IMAGE =
  "moby/buildkit:v0.32.2-rootless@sha256:504731e577c20559c00f968f33219f30115e70be29ab96728d1d06e963fc494b";

const BUILDKIT_STATE = "/home/user/.local/share/buildkit";

export interface KubernetesBuilderOptions extends KubernetesConnection {
  /** Where builder Jobs are created (`RYPH_ENV_BUILD_NAMESPACE`, default `ryph-builds`). */
  namespace: string;
  /** A default-branch build pod's service account — Workload Identity's anchor on GKE. */
  serviceAccount: string;
  /** A branch build pod's: bound to an identity that cannot write `registry`. */
  branchServiceAccount: string;
  /**
   * The sandbox every build pod runs under (`gvisor` on GKE). A build pod's BuildKit runs with
   * seccomp and AppArmor unconfined, so this is its one boundary: unset is refused unless
   * `allowUnsandboxed` (see UNSANDBOXED_BUILDS_REFUSED).
   */
  runtimeClass?: string;
  /** `RYPH_ENV_BUILD_ALLOW_UNSANDBOXED=on`: build on the node's own kernel. Laptop clusters only. */
  allowUnsandboxed?: boolean;
  /** `RYPH_ENV_REGISTRY`: `<registry>/<subjectKey>` is where each default-branch environment is
   * pushed, and where every layer cache lives. */
  registry: string;
  /** `RYPH_ENV_BRANCH_REGISTRY`: where branch environments are pushed. May equal `registry` only
   * where the registry has no credential to steal (`registryAuth: none`). */
  branchRegistry: string;
  buildkitImage: string;
  /** buildkitd's snapshotter. Defaults to `native`; see DEFAULT_SNAPSHOTTER on why. */
  snapshotter?: string;
  /** The build pod's resources; `workVolume` is the disk BuildKit's state and the clones get. */
  size: RunSize;
  /** The StorageClass of that disk. Unset: the cluster default. */
  volumeClass?: string;
  /**
   * How BuildKit authenticates to the registry. `gke-metadata`: a credential helper that asks the
   * GKE metadata server for the pod's Workload Identity token on every push and pull. `none`: an
   * open registry (a laptop cluster's).
   */
  registryAuth: "gke-metadata" | "none";
  /** How often a running build's Job is looked at. */
  pollIntervalMs?: number;
  /** The backstop for a finished Job nobody deleted, and adoption's window. See
   * DEFAULT_TTL_SECONDS, which is what this defaults to. */
  ttlSecondsAfterFinished?: number;
  /** A cap on each API request, so a connection that hangs cannot hold a build slot for ever. */
  requestTimeoutMs?: number;
}

export interface KubernetesBuilderDeps {
  fetch?: typeof fetch;
  /** An OAuth access token for removing images from Artifact Registry; defaults to the metadata
   * server's (the control plane's Workload Identity on GKE). */
  token?: () => Promise<string>;
}

/**
 * buildkitd's garbage collector, sized to the build's OWN work volume.
 *
 * MEASURED, v0.32.2: left to itself buildkitd derives its policy from the filesystem its state
 * sits on — on a 50Gi volume that is `reserved 6GB, minimum free 11GB, maximum used 41GB`, so it
 * starts throwing layers away once the volume is 39GB full, and on a 36Gi one once it is 28GB
 * full. That is not a generous margin for a `native` build: MEASURED, four passes over a base
 * image of 1.9GB left 32.6GB of state, because a native snapshot is a copy of the whole
 * filesystem and not a diff. And a collector that fires takes the build apart — MEASURED on a
 * 34.95GB state: a daemon whose policy it exceeded pruned it to 4.34GB within 90 seconds, saying
 * nothing in its log, while the same state under the policy below lost nothing. What a prune
 * costs is the whole base image again, at 485-548s for 1.9GB of it under `native` against 0-1s
 * for a pass that finds it. The volume belongs to one build and dies with it, so nothing on it
 * is worth keeping for later: the only reason to collect at all is to not run out of disk.
 *
 * Hence a policy that keeps everything until the volume is nearly full. The flag takes
 * `Reserved[,Free[,Maximum]]` in WHOLE MEGABYTES — MEASURED: `40GB` does not parse and buildkitd
 * exits — so the sizes are rendered as integers. A build with no work volume of its own
 * (`emptyDir`, a laptop cluster) keeps buildkitd's defaults: the disk is the node's, and filling
 * it is the node's problem, not this build's.
 */
export function gcKeepStorage(workVolume: string | null): string | null {
  if (workVolume === null) return null;
  let mb: number;
  try {
    mb = Math.floor(quantityBytes(workVolume) / 1e6);
  } catch {
    return null;
  }
  if (mb < 1024) return null;
  const reserved = Math.floor(mb * 0.8);
  const free = Math.floor(mb * 0.05);
  const maximum = Math.floor(mb * 0.9);
  return `${reserved},${free},${maximum}`;
}

/** The daemon flags the buildkit container starts buildkitd with. */
export function buildkitdFlags(opts: KubernetesBuilderOptions): string {
  const gc = gcKeepStorage(opts.size.workVolume);
  return [
    // No process sandbox: the rootless worker cannot make one without privileges a pod is not
    // given. See the header on what that costs.
    "--oci-worker-no-process-sandbox",
    `--oci-worker-snapshotter=${opts.snapshotter ?? DEFAULT_SNAPSHOTTER}`,
    ...(gc === null ? [] : [`--oci-worker-gc-keepstorage=${gc}`]),
  ].join(" ");
}

/** The shared script's view of this backend: rootless, under the pod's own identity. */
export function scriptOptions(opts: KubernetesBuilderOptions): ScriptOptions {
  return {
    registry: opts.registry,
    branchRegistry: opts.branchRegistry,
    registryAuth: opts.registryAuth,
    daemon: "rootless",
    // The pod's NetworkPolicy already holds steps to the proxy, the gateway and DNS.
    confineSteps: null,
  };
}

/** One Job per build; the environment id makes it findable by hand. */
export function buildJobName(environmentId: string): string {
  return `ryph-build-${safeName(environmentId, 40)}`;
}

function labelsFor(spec: BuildSpec): Record<string, string> {
  return {
    "app.kubernetes.io/managed-by": "ryph",
    // What the ryph-builds NetworkPolicy selects, and what the egress proxy and the forge admit.
    "app.kubernetes.io/component": "environment-build",
    "ryph.environment": safeName(spec.environmentId, 63),
  };
}

/** The Secret's key for one env var: the two groups never collide, and each goes to one container. */
const cloneKey = (name: string) => `clone.${name}`;
const proxyKey = (name: string) => `proxy.${name}`;

type Container = Record<string, unknown>;

export interface BuildJobManifest {
  apiVersion: "batch/v1";
  kind: "Job";
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
    uid?: string;
  };
  spec: Record<string, unknown>;
  status?: {
    conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
  };
}

/**
 * The Job one build creates — suspended; the Secret is written owned by it before it is released,
 * as the run provisioner does. Pure, and exported for the test.
 */
export function buildJobManifest(
  spec: BuildSpec,
  opts: KubernetesBuilderOptions,
): BuildJobManifest {
  if (!opts.runtimeClass && opts.allowUnsandboxed !== true) {
    throw new Error(UNSANDBOXED_BUILDS_REFUSED);
  }
  const name = buildJobName(spec.environmentId);
  const labels = labelsFor(spec);
  const secretEnv = (keys: string[], toKey: (k: string) => string) =>
    keys.map((key) => ({
      name: key,
      valueFrom: { secretKeyRef: { name, key: toKey(key) } },
    }));
  const resources: Record<string, string> = {
    ...(opts.size.cpu === null ? {} : { cpu: opts.size.cpu }),
    ...(opts.size.memory === null ? {} : { memory: opts.size.memory }),
    ...(opts.size.ephemeralStorage === null
      ? {}
      : { "ephemeral-storage": opts.size.ephemeralStorage }),
  };
  const sized = Object.keys(resources).length > 0
    ? { resources: { requests: resources, limits: resources } }
    : {};
  const volumeMounts = [{ name: "work", mountPath: WORK }];

  const clone: Container = {
    name: "clone",
    // The deployment's universal image: git and bash are two of its promises, and the node pulls
    // it for runs anyway.
    image: spec.baseImage,
    command: ["/bin/bash", "-c", initScript(spec), "init", ...initArgs(spec)],
    env: [
      { name: "HOME", value: `${WORK}/home` },
      { name: "GIT_TERMINAL_PROMPT", value: "0" },
      ...secretEnv(Object.keys(spec.clone.env).sort(), cloneKey),
    ],
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      runAsNonRoot: true,
      runAsUser: BUILDKIT_UID,
      runAsGroup: BUILDKIT_UID,
      seccompProfile: { type: "RuntimeDefault" },
    },
    ...sized,
    volumeMounts,
  };

  // The no-proxy list is not a secret, and on GKE it gains the metadata server, which the
  // credential helper reaches directly. Every spelling the spec used is set, so the build script
  // can hand each on as a build argument.
  const proxyKeys = proxyBuildArgs(spec.proxyEnv).map(([key]) => key);
  const isNoProxy = (key: string) => key.toUpperCase() === "NO_PROXY";
  const noProxy = [
    spec.proxyEnv.NO_PROXY ?? spec.proxyEnv.no_proxy,
    ...(opts.registryAuth === "gke-metadata"
      ? ["169.254.169.254", "metadata.google.internal"]
      : []),
  ].filter((v): v is string => v !== undefined && v !== "").join(",");
  const noProxyKeys = proxyKeys.filter(isNoProxy);
  if (noProxy !== "" && noProxyKeys.length === 0) noProxyKeys.push("NO_PROXY");
  const stepNoProxy = spec.proxyEnv.NO_PROXY ?? spec.proxyEnv.no_proxy;

  const buildkit: Container = {
    name: "buildkit",
    image: opts.buildkitImage,
    command: ["/bin/sh", "-c", buildScript(spec, scriptOptions(opts))],
    env: [
      // Read by the script, which starts ONE buildkitd with them for the whole build.
      { name: "BUILDKITD_FLAGS", value: buildkitdFlags(opts) },
      // buildkitd's own pulls and pushes cross the egress proxy like every step does.
      ...secretEnv(proxyKeys.filter((k) => !isNoProxy(k)), proxyKey),
      ...noProxyKeys.map((key) => ({ name: key, value: noProxy })),
      ...(stepNoProxy === undefined ? [] : [{ name: STEP_NO_PROXY, value: stepNoProxy }]),
    ],
    // Upstream's rootless shape: rootlesskit needs unconfined seccomp and AppArmor to build its
    // user namespace. Never root, never a capability added.
    securityContext: {
      runAsNonRoot: true,
      runAsUser: BUILDKIT_UID,
      runAsGroup: BUILDKIT_UID,
      seccompProfile: { type: "Unconfined" },
      appArmorProfile: { type: "Unconfined" },
    },
    ...sized,
    volumeMounts: [
      ...volumeMounts,
      { name: "work", mountPath: BUILDKIT_STATE, subPath: "buildkit" },
    ],
  };

  const volume = opts.size.workVolume === null ? { name: "work", emptyDir: {} } : {
    name: "work",
    ephemeral: {
      volumeClaimTemplate: {
        metadata: { labels },
        spec: {
          accessModes: ["ReadWriteOnce"],
          ...(opts.volumeClass ? { storageClassName: opts.volumeClass } : {}),
          resources: { requests: { storage: opts.size.workVolume } },
        },
      },
    },
  };

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: opts.namespace, labels },
    spec: {
      suspend: true,
      backoffLimit: 0,
      // The backstop: the adapter deletes the Job at the timeout itself, and this ends it if the
      // control plane is not there to.
      activeDeadlineSeconds: Math.ceil(spec.timeoutMs / 1000) + 120,
      ttlSecondsAfterFinished: opts.ttlSecondsAfterFinished ?? DEFAULT_TTL_SECONDS,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          // Which identity pushes: the trusted one for the default branch alone.
          serviceAccountName: spec.defaultBranch ? opts.serviceAccount : opts.branchServiceAccount,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          // Above reserved capacity's placeholders, whatever the cluster's default priority.
          priorityClassName: WORKLOAD_PRIORITY_CLASS,
          ...(opts.runtimeClass ? { runtimeClassName: opts.runtimeClass } : {}),
          // The volume is the rootless user's; fsGroup makes a fresh disk writable by it.
          securityContext: { fsGroup: BUILDKIT_UID, fsGroupChangePolicy: "OnRootMismatch" },
          volumes: [volume],
          initContainers: [clone],
          containers: [buildkit],
        },
      },
    },
  };
}

/** The Secret carrying the git credential and the egress claim, owned by the Job. */
export function buildSecretManifest(
  spec: BuildSpec,
  opts: Pick<KubernetesBuilderOptions, "namespace">,
  jobUid: string,
) {
  const name = buildJobName(spec.environmentId);
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name,
      namespace: opts.namespace,
      labels: labelsFor(spec),
      ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name, uid: jobUid }],
    },
    type: "Opaque",
    stringData: {
      ...Object.fromEntries(Object.entries(spec.clone.env).map(([k, v]) => [cloneKey(k), v])),
      ...Object.fromEntries(
        proxyBuildArgs(spec.proxyEnv)
          .filter(([k]) => k.toUpperCase() !== "NO_PROXY")
          .map(([k, v]) => [proxyKey(k), v]),
      ),
    },
  };
}

/** Waits `ms`, or less when the signal fires first. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function kubernetesEnvironmentBuilder(
  opts: KubernetesBuilderOptions,
  diag: Diagnostics,
  deps: KubernetesBuilderDeps = {},
): EnvironmentBuilder {
  if (!opts.runtimeClass && opts.allowUnsandboxed !== true) {
    throw new Error(UNSANDBOXED_BUILDS_REFUSED);
  }
  const api: KubernetesApi = kubernetesApi(opts, deps.fetch ?? globalThis.fetch, {
    requestTimeoutMs: opts.requestTimeoutMs ?? 60_000,
  });
  const ns = opts.namespace;
  const jobsPath = `/apis/batch/v1/namespaces/${ns}/jobs`;
  const pollMs = opts.pollIntervalMs ?? 5000;
  // Removal asks Artifact Registry as the CONTROL PLANE's Google identity, never a build pod's:
  // only a registry that takes Workload Identity is one this can delete from. An open registry
  // (a laptop cluster's) keeps what it is given; deleting a manifest there frees nothing until
  // the registry's own garbage collection runs, which is its operator's.
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const cleaner = opts.registryAuth === "gke-metadata"
    ? artifactRegistryCleaner(
      {
        registry: opts.registry,
        branchRegistry: opts.branchRegistry,
        requestTimeoutMs: opts.requestTimeoutMs,
      },
      diag,
      { fetch: fetchImpl, token: deps.token ?? metadataToken(fetchImpl) },
    )
    : null;

  async function deleteJob(name: string): Promise<void> {
    try {
      await api.call("DELETE", `${jobsPath}/${name}?propagationPolicy=Background`);
    } catch (err) {
      if (!(err instanceof KubeError && err.status === 404)) throw err;
    }
  }

  /**
   * Every container's log and every container's state, appended; best-effort throughout.
   *
   * `podsSeen` is whether the Job still HAS a pod, which is a different fact from the logs being
   * empty and the one that decides whether a `Complete` Job can be read at all: a pod goes with
   * its node, and a build node is scaled down soon after the build it was created for.
   */
  async function collect(
    name: string,
    log: BuildLog,
  ): Promise<{ clone: string; buildkit: string; podsSeen: number }> {
    const logs = { clone: "", buildkit: "", podsSeen: 0 };
    try {
      const selector = encodeURIComponent(`job-name=${name}`);
      const pods = await api.call(
        "GET",
        `/api/v1/namespaces/${ns}/pods?labelSelector=${selector}`,
      ) as {
        items?: Array<{
          metadata?: { name?: string };
          status?: {
            phase?: string;
            initContainerStatuses?: Array<{ name: string; state?: unknown }>;
            containerStatuses?: Array<{ name: string; state?: unknown }>;
          };
        }>;
      };
      for (const pod of pods.items ?? []) {
        const podName = pod.metadata?.name;
        if (!podName) continue;
        logs.podsSeen += 1;
        for (const container of ["clone", "buildkit"] as const) {
          try {
            const text = await api.text(
              "GET",
              `/api/v1/namespaces/${ns}/pods/${podName}/log?container=${container}`,
            );
            log.say(`── ${container} ──`);
            log.append(text);
            logs[container] = text;
          } catch (err) {
            log.say(`no ${container} log: ${err instanceof Error ? err.message : err}`);
          }
        }
        // A pod that never got going — an image it could not pull, a node it could not get —
        // explains itself only here, and only until it is deleted.
        const states = [
          ...(pod.status?.initContainerStatuses ?? []),
          ...(pod.status?.containerStatuses ?? []),
        ].map((c) => `${c.name}: ${JSON.stringify(c.state ?? {})}`);
        log.say(
          `pod ${podName} ${pod.status?.phase ?? "?"}${
            states.length ? ` — ${states.join("; ")}` : ""
          }`,
        );
      }
    } catch (err) {
      log.say(`could not read the build pod: ${err instanceof Error ? err.message : err}`);
    }
    return logs;
  }

  /**
   * A Job from wherever it is now to the build's verdict: watched until it ends, its pod log read,
   * and the `@@ryph-result` lines turned into a result. The whole second half of a build, and the
   * whole of an adoption — which is the point: a Job that another process created is read here by
   * exactly the code that would have read it there, so adopting a build costs the control plane
   * nothing but the watching.
   *
   * It leaves the Job STANDING. The result is not safe anywhere until the core has written the
   * row, and the Job is what a later control plane would read it from; `discard` ends it once
   * that write has happened.
   */
  async function finish(
    spec: AdoptSpec,
    log: BuildLog,
    signal: AbortSignal,
    deadline: number,
  ): Promise<BuildResult> {
    const name = buildJobName(spec.environmentId);
    const fail = (kind: "failed" | "timeout", message: string): BuildResult => {
      log.say(message);
      return { ok: false, kind, message, logTail: log.tail(), log: log.text() };
    };
    let outcome: "complete" | "failed" | "timeout" | "cancelled" | null = null;
    let reason = "";
    while (outcome === null) {
      if (signal.aborted) {
        outcome = "cancelled";
        break;
      }
      if (Date.now() >= deadline) {
        outcome = "timeout";
        break;
      }
      try {
        const current = await api.call("GET", `${jobsPath}/${name}`) as BuildJobManifest;
        for (const c of current?.status?.conditions ?? []) {
          if (c.status !== "True") continue;
          if (c.type === "Complete") outcome = "complete";
          if (c.type === "Failed") {
            outcome = "failed";
            reason = [c.reason, c.message].filter(Boolean).join(": ");
          }
        }
      } catch (err) {
        if (err instanceof KubeError && err.status === 404) {
          outcome = "failed";
          reason = "the build job disappeared";
        } else {
          // A blip on the API server is not a failed build; the deadline still bounds this.
          diag.warn("environment_builder.kubernetes.poll_failed", { job: name, err: String(err) });
        }
      }
      if (outcome === null) {
        await pause(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
      }
    }

    const logs = await collect(name, log);
    const buildkitLog = logs.buildkit;
    if (outcome !== "complete") {
      if (outcome === "timeout") {
        return fail(
          "timeout",
          `the build ran past its ${Math.round(spec.timeoutMs / 60_000)} minute limit`,
        );
      }
      if (outcome === "cancelled") return fail("failed", "the build was cancelled");
      const why = failureLine(`${logs.clone}\n${logs.buildkit}`) ??
        logTail(logs.buildkit || logs.clone, 1);
      return fail(
        "failed",
        `the environment build failed${reason ? ` (${reason})` : ""}${why ? `: ${why}` : ""}`,
      );
    }

    // A `Complete` Job whose pod is not there any more is a build that SUCCEEDED and whose result
    // cannot be read: the digests were printed to a log that went with its node (a build node is
    // scaled down soon after the build it was created for, and an adopted Job is often minutes
    // old). Blaming the build for reporting no digest would be a lie, and one with consequences —
    // a failed row for a harness re-layer is not asked for again on the same harness. It says what
    // happened instead, and the image, which really was pushed, is rebuilt and re-pushed. What it
    // pushed is untagged once the failed row can no longer be pushing, and reconciled away after.
    if (logs.podsSeen === 0) {
      return fail(
        "failed",
        "the build finished, but its pod was gone before its result could be read — its image " +
          "was pushed and cannot be named, so this build has to be run again",
      );
    }
    const read = readScriptResult(buildkitLog, spec, opts);
    if (!read.ok) return fail("failed", read.message);
    const { image, bakedImage, machineImage, toolchains, setupWarnings, warm } = read;
    log.say(`built ${image}`);
    diag.debug("environment_builder.kubernetes.built", {
      environmentId: spec.environmentId,
      image,
    });
    return {
      ok: true,
      image,
      bakedImage,
      machineImage,
      sizeBytes: null,
      toolchains,
      setupWarnings,
      warm,
      log: log.text(),
    };
  }

  return {
    kind: "kubernetes",

    ...(cleaner === null ? {} : {
      removeImages: cleaner.removeBuild,
      pruneCache: (prune: { retiredForMs: number }) => cleaner.pruneCache(prune.retiredForMs),
      reconcileImages: cleaner.reconcileImages,
      removalStats: cleaner.removalStats,
    }),

    /**
     * The row is written (or the build is superseded and nobody will write one): the Job goes,
     * and its pod's work volume — a PersistentVolumeClaim the namespace's quota counts — with it.
     * Also how a build whose replica died is STOPPED: superseding a row aborts nothing in a
     * process that is not there, and without this the Job would run on to its
     * `activeDeadlineSeconds` holding a node and a volume nobody wants any more.
     */
    async discard(environmentId: string): Promise<void> {
      const name = buildJobName(environmentId);
      await deleteJob(name);
      diag.debug("environment_builder.kubernetes.discarded", {
        environmentId,
        job: `${ns}/${name}`,
      });
    },

    /** The build pod's logs as they stand: the clone's whole, BuildKit's last lines. Any
     * replica can read them — the pod is the record — so this answers wherever it is asked. */
    async liveLog(spec): Promise<string | null> {
      const name = buildJobName(spec.environmentId);
      try {
        const selector = encodeURIComponent(`job-name=${name}`);
        const pods = await api.call(
          "GET",
          `/api/v1/namespaces/${ns}/pods?labelSelector=${selector}`,
        ) as { items?: Array<{ metadata?: { name?: string } }> };
        const pod = pods.items?.at(-1)?.metadata?.name;
        if (!pod) return null;
        const parts: string[] = [];
        for (const [container, tail] of [["clone", ""], ["buildkit", "&tailLines=2000"]]) {
          const text = await api.text(
            "GET",
            `/api/v1/namespaces/${ns}/pods/${pod}/log?container=${container}${tail}`,
          ).catch(() => "");
          if (text !== "") parts.push(`── ${container} ──\n${text}`);
        }
        return parts.length === 0 ? null : parts.join("\n");
      } catch {
        return null;
      }
    },

    async build(spec: BuildSpec, { signal }): Promise<BuildResult> {
      assertBuildable(spec);
      const log = new BuildLog();
      const job = buildJobManifest(spec, opts);
      const name = job.metadata.name;
      const fail = (kind: "failed" | "timeout", message: string): BuildResult => {
        log.say(message);
        return { ok: false, kind, message, logTail: log.tail(), log: log.text() };
      };

      log.say(`environment ${spec.environmentId} for ${spec.subjectKey}: job ${ns}/${name}`);
      try {
        const created = await api.call("POST", jobsPath, job) as BuildJobManifest;
        const uid = created?.metadata?.uid;
        try {
          if (!uid) throw new Error(`kubernetes created job ${name} but returned no uid`);
          await api.call(
            "POST",
            `/api/v1/namespaces/${ns}/secrets`,
            buildSecretManifest(spec, opts, uid),
          );
          await api.call(
            "PATCH",
            `${jobsPath}/${name}`,
            { spec: { suspend: false } },
            "application/merge-patch+json",
          );
        } catch (err) {
          await deleteJob(name).catch(() => {});
          throw err;
        }
      } catch (err) {
        // The API server refused the Job or its Secret: nothing was built, and nothing is left.
        return fail(
          "failed",
          `could not start the build job: ${err instanceof Error ? err.message : err}`,
        );
      }
      diag.debug("environment_builder.kubernetes.started", {
        environmentId: spec.environmentId,
        job: `${ns}/${name}`,
      });

      return await finish(spec, log, signal, Date.now() + spec.timeoutMs);
    },

    async adopt(spec: AdoptSpec, { signal }): Promise<AdoptResult> {
      const name = buildJobName(spec.environmentId);
      const log = new BuildLog();
      let found: BuildJobManifest;
      try {
        found = await api.call("GET", `${jobsPath}/${name}`) as BuildJobManifest;
      } catch (err) {
        // 404 is an ANSWER, and the only one that lets the core fail a row outright: this cluster
        // has no such build, so nothing is running and nothing is coming. Anything else — a
        // refused request, an API server that did not answer — is not an answer at all, and
        // saying "gone" to it would fail builds that are running perfectly well.
        if (err instanceof KubeError && err.status === 404) {
          diag.debug("environment_builder.kubernetes.adopt_gone", {
            environmentId: spec.environmentId,
            job: `${ns}/${name}`,
          });
          return { kind: "gone" };
        }
        return { kind: "unknown", why: err instanceof Error ? err.message : String(err) };
      }
      // A Job still SUSPENDED is one whose creator died in the three calls between `POST` and the
      // release: it has never run a pod, its Secret may never have been written, and a suspended
      // Job's `activeDeadlineSeconds` does not count down — so watching it would wait out the
      // whole build timeout for something that was never going to start. Releasing it is no
      // better: without the Secret its pod cannot start either. It goes, and the row fails now,
      // which leaves the next trigger free to queue a build that will actually run.
      if ((found?.spec as { suspend?: boolean } | undefined)?.suspend === true) {
        diag.warn("environment_builder.kubernetes.adopt_unreleased", {
          environmentId: spec.environmentId,
          job: `${ns}/${name}`,
        });
        await deleteJob(name).catch((err) =>
          diag.warn("environment_builder.kubernetes.delete_failed", { job: name, err: String(err) })
        );
        return { kind: "gone" };
      }
      log.say(
        `environment ${spec.environmentId} for ${spec.subjectKey}: adopted job ${ns}/${name}`,
      );
      diag.warn("environment_builder.kubernetes.adopted", {
        environmentId: spec.environmentId,
        job: `${ns}/${name}`,
      });
      // The Job's own `activeDeadlineSeconds` — set when it was created, and counted from when it
      // started, not from now — is what really bounds an adopted build; this deadline is only the
      // watcher's own backstop, and generous on purpose, because the adopter cannot know how much
      // of the build's time has already been spent.
      return {
        kind: "settled",
        result: await finish(spec, log, signal, Date.now() + spec.timeoutMs),
      };
    },
  };
}
