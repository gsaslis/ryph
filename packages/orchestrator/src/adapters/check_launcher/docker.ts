// A local-docker `CheckLauncher`: the kubernetes pod's shape, spelled in docker's parts. Per suite
// generation, all named from the spec's record name and all labelled with it:
//   - volumes `<name>-pristine`, with a memory pool `<name>-pool-<check>` (each check's directory
//     of the pool, read-write in its own container and read-only in every other check's:
//     sh/pool.sh) and, when the image baked no checkout of this repo,
//     `<name>-work-<check>`, all handed to the run user by a one-shot `chown` container (a new named
//     volume is root's, and every stage here runs as 1994). With a baked checkout a check works
//     in its own container's copy of the image instead, and runs the setup steps there: there is
//     no work volume and no setup container (scripts.ts says why there are two shapes)
//   - with services, a network `<name>` and a container `<name>-svc-<service>` per service on it,
//     under the declared name as its alias — the same contract a run's services keep
//   - one CREATED container per stage — `<name>-clone`, `<name>-setup-<i>`, `<name>-check-<x>` —
//     each running the platform's bash script (scripts.ts) as its entrypoint behind docker's own
//     `--init`. The image is usually the baked one, which has no harness layer and so no tini of
//     its own; docker's comes from the daemon, so the repo's orphans are reaped whatever the image
//
// There is no pod to sequence the stages, so `poll` does: it reads every stage's state by label
// and starts the next one when the one before it exited 0 — the services and every check
// together, once setup is done. That makes a suite a thing ANY replica can drive, not only the
// one that launched it: the state is the containers', and starting a container that is already
// started is skipped rather than repeated. Two replicas can still both read a stage as created and
// both start it, the second after the first has exited; every stage's script makes a mark first,
// in its volume or (a baked check) in its own container's filesystem, which a restart keeps, and
// answers a second start with the platform's exit code, so a stage never runs twice. The cost is
// a poll interval between stages.
//
// Images are pulled by `prepare`, in the background, before the core launches anything from
// them: a cold pull of an environment image takes minutes, and the core's tick, which awaits
// every launch, must not stop polling, settling and reporting every other suite meanwhile. A suite
// whose images are still coming waits in the queue. One pull per image in this process, killed
// past PULL_TIMEOUT_MS, and a failed one answered, while fresh, to every suite on the image that
// has not changed since the pull started, as a failed launch attempt naming why: a suite charged
// meanwhile pulls again. A
// launch still pulls an image it does not find (another replica's prepare, an image removed in
// between), so its pristine volume is made first: a record with that volume and no clone
// container yet is a launch still pulling (`pending`) until LAUNCH_GRACE_MS, and only then one
// that died (`gone`).
//
// The verdict is each check container's exit code from `docker inspect`, as the kubernetes one is
// the pod status: nothing in the container can write it.
//
// Labels, and the ones deliberately NOT used: `ryph.check` (the record name) and
// `ryph.deployment` (whose daemon this is — see the run provisioner on two deployments sharing
// one). Never `ryph.run` or any `ryph.role`: the run provisioner's `reclaimOrphans` removes
// any such object whose run id is not an active run, and a suite id never is one.
//
// What this backend does not give, said once: egress is NOT enforced unless the deployment confines
// its runs (`runNetwork` — then a check joins the same internal network and reaches ryph through
// the same run gate; otherwise it keeps the default route, exactly as a run's does — see
// provisioner/docker.ts), `docker inspect` shows
// every `-e` value including the clone's credential and the egress claim (the run provisioner's
// accepted tradeoff; the credential is one-shot, scoped to one commit, and revoked once the clone
// is done), there is no deadline (the core's is the only one), disk is not sized, a suite's memory
// is held per check, not as a pool: docker has no limit on a group of containers, and each check's
// `--memory` is its share (`--memory-swap` the same: no swap past it), so the kernel kills a check
// over its share alone (its pool watcher,
// sh/pool.sh, runs and never fires; the head can disable a watcher, so a limit of the
// whole pool per check would let one suite take N times its cap of the host), and a suite's
// network gives addressing isolation, not enforced isolation (OrbStack's networks do not
// isolate). Docker is for development and trusted deployments; Kubernetes is the boundary.

import { command } from "@ryph/process";
import { ImageGone } from "../../ports/image_gone.ts";
import type {
  CheckContainerState,
  CheckInspection,
  CheckLauncher,
  CheckSpec,
} from "../../ports/check_launcher.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import type { ServiceSpec } from "../../ports/provisioner.ts";
import { CHECK_PLATFORM_EXIT } from "../../core/checks.ts";
import { CHECK_POOL_EXIT } from "../../core/check_types.ts";
import { memoryMebibytes, quantityBytes, quantityCores } from "../../core/run_sizes.ts";
import {
  type CheckCaps,
  confinedNetworkFlags,
  type DockerOptions,
  ensureGate,
  gateForcedWarning,
} from "../provisioner/docker.ts";
import {
  daemonLacksImage,
  type ImageVerdict,
  judgeImage,
  localImagePrefix,
  localOnlyImage,
  notOwnImage,
  refusedImageSpelling,
} from "../environment_builder/local_images.ts";
import {
  bakedCheckScript,
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

/** The record name, on every container, volume and network of a suite generation. */
export const CHECK_LABEL = "ryph.check";
/** Which stage a container is: `clone`, `setup-<i>`, `check-<name>`, `svc-<service>`. */
export const STAGE_LABEL = "ryph.check-stage";
/** On a check container: `<share bytes>/<pool bytes>`, the memory pool it was launched with, so a
 * poll can name the numbers when the pool watcher stopped it. */
export const POOL_LABEL = "ryph.check-pool";
/** The run provisioner's label and meaning; see its `deploymentId`. */
const DEPLOYMENT_LABEL = "ryph.deployment";

/** The run user every image we ship pins (provisioner/kubernetes.ts DEFAULT_RUN_USER). */
const RUN_USER = "1994:1994";

/** A container's log is capped by the daemon, so `logs` never reads more than this back. */
const LOG_MAX_SIZE = "10m";

/**
 * How long a record with no clone container yet counts as a launch still in progress rather than
 * one that died: a launch pulls its images first, and a cold pull of an environment image can take
 * many minutes. Past this, `poll` answers `gone` and the core launches again.
 */
export const LAUNCH_GRACE_MS = 15 * 60_000;

/** How long one image pull may take before it is killed and answered as failed. */
export const PULL_TIMEOUT_MS = 30 * 60_000;

/** An image gone between `prepare` and `launch` is pulled inline, held under the launch lease. */
export const INLINE_PULL_MS = 5 * 60_000;

/** How long a failed pull is the answer for the suites on its image; then it is pulled again. A
 * replica that asks only now and then must still find it. */
export const PULL_FAILURE_ANSWER_MS = 10 * 60_000;

/**
 * RYPH_CHECKS_CPUS / RYPH_CHECKS_MEMORY: the most any one container of a suite may use (a check,
 * a setup step, the clone). Every check may use all of the cpus, so a suite's lint does not hold
 * cores its tests are waiting for: contention for cpu only shares it, nobody is killed. A check's
 * memory is its share of the class, held under the cap (`launchPlan`). Unset is `auto`, half of
 * what the daemon has: one check can no longer take the whole machine from the runs and suites
 * beside it. `off` caps nothing. A Kubernetes cpu or memory quantity otherwise (`4`, `500m`; `6Gi`). The
 * size class, where it sets one, still applies beneath.
 */
export function checkCapsFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
): CheckCaps {
  const read = (
    name: string,
    parse: (value: string) => number,
    example: string,
  ): number | "auto" | null => {
    const value = env(name)?.trim() || "auto";
    if (value.toLowerCase() === "auto") return "auto";
    if (value.toLowerCase() === "off") return null;
    let n = NaN;
    try {
      n = parse(value);
    } catch { /* refused below */ }
    if (!(n > 0)) fail(`${name} must be auto, off or ${example}, got ${JSON.stringify(value)}`);
    return n;
  };
  const cpus = read("RYPH_CHECKS_CPUS", quantityCores, "a cpu quantity like 4 or 500m");
  // Docker's own floor for --cpus: anything under it is refused at every create.
  if (typeof cpus === "number" && cpus < 0.01) {
    fail(`RYPH_CHECKS_CPUS must be at least 0.01 (10m), docker's smallest cpu limit`);
  }
  return {
    cpus,
    memoryMi: read(
      "RYPH_CHECKS_MEMORY",
      (v) => Math.ceil(quantityBytes(v) / 2 ** 20),
      "a memory quantity like 6Gi",
    ),
  };
}

/** `auto` made concrete from what the daemon has: half its cpus (at least one) and half its
 * memory (at least CHECK_FLOOR's 512Mi). A cpu cap set outright is held to the daemon's cpus,
 * since docker refuses a `--cpus` above them. */
export function resolveCheckCaps(
  caps: CheckCaps,
  daemon: { cpus: number; memoryBytes: number },
): CheckCaps {
  const half = (value: number, floor: number) =>
    Number.isFinite(value) && value > 0 ? Math.max(floor, Math.floor(value / 2)) : null;
  return {
    cpus: caps.cpus === "auto"
      ? half(daemon.cpus, 1)
      : caps.cpus !== null && Number.isFinite(daemon.cpus) && daemon.cpus > 0
      ? Math.min(caps.cpus, daemon.cpus)
      : caps.cpus,
    memoryMi: caps.memoryMi === "auto" ? half(daemon.memoryBytes / 2 ** 20, 512) : caps.memoryMi,
  };
}

export type DockerExec = (args: string[], opts?: { signal?: AbortSignal }) => Promise<string>;

/** The docker CLI, its stdout trimmed; a non-zero exit throws with docker's stderr. */
export async function docker(
  args: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  const { code, stdout, stderr } = await command("docker", {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  }).output();
  if (code !== 0) {
    throw new Error(`docker ${args[0]} failed: ${new TextDecoder().decode(stderr).trim()}`);
  }
  return new TextDecoder().decode(stdout).trim();
}

/** The run provisioner's deployment identity: the network it puts its containers on. */
function deploymentId(opts: DockerOptions): string {
  return opts.network ?? "default";
}

export const containerName = (name: string, stage: string): string => `${name}-${stage}`;
export const pristineVolume = (name: string): string => `${name}-pristine`;
export const workVolume = (name: string, check: string): string => `${name}-work-${check}`;
export const poolVolume = (name: string, check: string): string => `${name}-pool-${check}`;

function labels(name: string, opts: DockerOptions, stage?: string): string[] {
  return [
    "--label",
    `${CHECK_LABEL}=${name}`,
    "--label",
    `${DEPLOYMENT_LABEL}=${deploymentId(opts)}`,
    ...(stage === undefined ? [] : ["--label", `${STAGE_LABEL}=${stage}`]),
  ];
}

const env = (vars: Record<string, string>): string[] =>
  Object.entries(vars).flatMap(([key, value]) => ["-e", `${key}=${value}`]);

const mount = (volume: string, target: string, readOnly = false): string[] => [
  "--mount",
  `type=volume,source=${volume},target=${target},volume-nocopy${readOnly ? ",readonly" : ""}`,
];

/**
 * The flags every stage container shares: never root, nothing added, the deployment's runtime,
 * and docker's init as PID 1, so what the repo's commands orphan is reaped and not left to bash.
 */
function stageCommon(
  spec: CheckSpec,
  opts: DockerOptions,
  stage: string,
  resources: { cpus: number | null; memoryMi: number | null },
): string[] {
  return [
    "create",
    // Pulled before any of it is made (`launch`): a ryph-env image docker cannot find must never
    // be asked of Docker Hub.
    "--pull",
    "never",
    "--name",
    containerName(spec.name, stage),
    ...labels(spec.name, opts, stage),
    "--user",
    RUN_USER,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    ...(opts.runtime ? ["--runtime", opts.runtime] : []),
    "--init",
    // Confined like a run on a deployment that confines runs: the internal network alone, ryph
    // through the run gate. Otherwise the name the gateway and the egress proxy have in host
    // mode (see the run provisioner).
    ...(opts.runNetwork ? ["--network", opts.runNetwork] : [
      "--add-host",
      "host.docker.internal:host-gateway",
      ...(opts.network ? ["--network", opts.network] : []),
    ]),
    // A check's output is head-authored and unbounded; the daemon keeps the last of it only.
    "--log-driver",
    "json-file",
    "--log-opt",
    `max-size=${LOG_MAX_SIZE}`,
    "--log-opt",
    "max-file=1",
    ...(resources.cpus === null ? [] : ["--cpus", String(resources.cpus)]),
    // Swap held to nothing past the limit: docker's default lets a container swap as much again,
    // where a check over its share would go on unseen (its watcher reads memory, not swap).
    ...(resources.memoryMi === null
      ? []
      : ["--memory", `${resources.memoryMi}m`, "--memory-swap", `${resources.memoryMi}m`]),
    "--entrypoint",
    "/bin/bash",
  ];
}

/**
 * Every `docker` argv a launch runs, in order. Pure, and exported for the test: this is the
 * contract between the orchestrator and a suite's containers on this backend, as the Job manifest
 * is on kubernetes.
 */
export function launchPlan(spec: CheckSpec, opts: DockerOptions): {
  /** Every image a stage or service runs, pulled before anything is created from one. */
  images: string[];
  network: string[] | null;
  volumes: string[][];
  chown: string[];
  services: string[][];
  setup: string[][];
  checks: Array<{ create: string[]; connect: string[] | null }>;
  clone: string[];
} {
  assertLaunchable(spec);
  const name = spec.name;
  const serviceNames = spec.services.map((s) => s.name);
  const proxy = checkProxyEnv(spec.proxyEnv, serviceNames);
  // Every stage's resources, held under the deployment's cap where it sets one (an `auto` not
  // yet resolved caps nothing): setup and the clone too, since an `npm ci` or a `cargo build` in
  // setup takes as much of the daemon as any check. The checks get all of the cpus too, since
  // contention for cpu only shares it. Memory they do not: each check is limited to its share of
  // the pool, since docker has no limit to put on a group of containers and the head can disable
  // its own pool watcher. With the whole pool for each, one suite could take N times its cap of
  // the host; with its share, the kernel kills a check over it alone.
  const capped = (share: number | null, cap: number | "auto" | null | undefined) =>
    typeof cap !== "number" ? share : share === null ? cap : Math.min(share, cap);
  const whole = {
    cpus: capped(
      spec.size.cpu === null ? null : quantityCores(spec.size.cpu),
      opts.checkCaps?.cpus,
    ),
    memoryMi: capped(
      spec.size.memory === null ? null : memoryMebibytes(spec.size.memory),
      opts.checkCaps?.memoryMi,
    ),
  };
  const share = checkShare({ ...spec.size, ephemeralStorage: null }, spec.checks.length);
  const each = {
    cpus: whole.cpus,
    memoryMi: capped(
      share.memory === null ? null : memoryMebibytes(share.memory),
      opts.checkCaps?.memoryMi,
    ),
  };
  // What the watcher is told is the limit the kernel holds: a check never gets past its share to
  // be found the furthest over it, so on docker the watcher never fires.
  const pool: MemoryPool | null = whole.memoryMi === null || each.memoryMi === null ? null : {
    bytes: whole.memoryMi * 2 ** 20,
    shareBytes: each.memoryMi * 2 ** 20,
  };
  const baked = bakedTree(spec) !== null;
  const volumes = [
    pristineVolume(name),
    ...(pool === null ? [] : spec.checks.map((c) => poolVolume(name, c.name))),
    ...(baked ? [] : spec.checks.map((c) => workVolume(name, c.name))),
  ];

  return {
    images: [...new Set([spec.image, ...spec.services.map((s) => s.image)])],
    // `--internal` on a confined deployment, or the services' network is the suite's way out.
    network: spec.services.length === 0 ? null : [
      "network",
      "create",
      ...confinedNetworkFlags(opts),
      ...labels(name, opts),
      name,
    ],
    volumes: volumes.map((v) => ["volume", "create", ...labels(name, opts), v]),
    // Root, once, with CHOWN and nothing else, and no network: a new named volume is root's.
    chown: [
      "run",
      "--pull",
      "never",
      "--rm",
      "--name",
      containerName(name, "chown"),
      ...labels(name, opts, "chown"),
      "--user",
      "0:0",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--security-opt",
      "no-new-privileges",
      ...(opts.runtime ? ["--runtime", opts.runtime] : []),
      "--network",
      "none",
      ...volumes.flatMap((v) => mount(v, `/v/${v}`)),
      "--entrypoint",
      "/bin/chown",
      spec.image,
      RUN_USER,
      ...volumes.map((v) => `/v/${v}`),
    ],
    services: spec.services.map((service) => serviceArgs(spec, service, opts)),
    // With a baked checkout, setup runs in each check container (its env carries the steps).
    setup: baked ? [] : spec.setup.map((step, i) => [
      ...stageCommon(spec, opts, setupContainer(i), whole),
      ...mount(pristineVolume(name), PRISTINE),
      ...env({ ...setupEnv(step, i), ...proxy }),
      spec.image,
      "-c",
      setupScript(),
    ]),
    checks: spec.checks.map((check) => ({
      create: [
        ...stageCommon(spec, opts, checkContainer(check.name), each),
        ...(pool === null ? [] : ["--label", `${POOL_LABEL}=${pool.shareBytes}/${pool.bytes}`]),
        ...mount(pristineVolume(name), PRISTINE, true),
        // Its own pool directory read-write, and only its own: every other check's read-only.
        ...(pool === null
          ? []
          : spec.checks.flatMap((c) =>
            mount(poolVolume(name, c.name), `${POOL}/${c.name}`, c.name !== check.name)
          )),
        ...(baked ? [] : mount(workVolume(name, check.name), WORK)),
        ...env({ ...checkEnv(check, spec, pool), ...proxy }),
        spec.image,
        "-c",
        baked ? bakedCheckScript() : checkScript(),
      ],
      // Joined to the services' network before it ever starts, like a run's agent.
      connect: spec.services.length === 0
        ? null
        : ["network", "connect", name, containerName(name, checkContainer(check.name))],
    })),
    // LAST: its existence is what says the launch finished creating everything (see `launch`).
    clone: [
      ...stageCommon(spec, opts, CLONE_CONTAINER, whole),
      ...mount(pristineVolume(name), PRISTINE),
      // The credential, on this container and no other.
      ...env({ ...cloneEnv(spec), ...spec.clone.env }),
      spec.image,
      "-c",
      cloneScript(),
    ],
  };
}

/**
 * One service container, as the run provisioner's `serviceArgs` makes it — the catalogue's
 * capabilities on top of ALL dropped, the deployment's runtime, the declared name as its alias —
 * but CREATED, not run (it starts once setup is done), and under this launcher's labels.
 */
export function serviceArgs(spec: CheckSpec, service: ServiceSpec, opts: DockerOptions): string[] {
  const stage = `svc-${service.name}`;
  return [
    "create",
    "--pull",
    "never",
    "--name",
    containerName(spec.name, stage),
    ...labels(spec.name, opts, stage),
    "--network",
    spec.name,
    "--network-alias",
    service.name,
    "--restart",
    "no",
    "--cap-drop",
    "ALL",
    ...(opts.runtime ? ["--runtime", opts.runtime] : []),
    ...service.security.capabilities.flatMap((cap) => ["--cap-add", cap]),
    "--security-opt",
    "no-new-privileges",
    "--memory",
    service.resources.memory,
    "--cpus",
    service.resources.cpus,
    ...env(service.env),
    service.image,
    ...(service.command ?? []),
  ];
}

/** One container of a suite, as `docker inspect` reports it. */
export interface StageState {
  stage: string;
  status: string;
  exitCode: number;
  oomKilled: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  /** The memory pool a check container was launched with (POOL_LABEL), or null. */
  pool: MemoryPool | null;
}

const INSPECT_FORMAT = [
  `{{index .Config.Labels "${STAGE_LABEL}"}}`,
  "{{.State.Status}}",
  "{{.State.ExitCode}}",
  "{{.State.OOMKilled}}",
  "{{.State.StartedAt}}",
  "{{.State.FinishedAt}}",
  `{{index .Config.Labels "${POOL_LABEL}"}}`,
].join("\t");

/** `docker inspect --format INSPECT_FORMAT` lines, parsed. Exported for the test. */
export function parseStages(out: string): Map<string, StageState> {
  const stages = new Map<string, StageState>();
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    const [stage, status, exitCode, oom, startedAt, finishedAt, pool = ""] = line.split("\t");
    if (!stage) continue;
    const [shareBytes, bytes] = pool.split("/").map(Number);
    stages.set(stage, {
      stage,
      status,
      exitCode: Number(exitCode),
      oomKilled: oom === "true",
      startedAt: timestamp(startedAt),
      finishedAt: timestamp(finishedAt),
      pool: bytes! > 0 && shareBytes! > 0 ? { bytes: bytes!, shareBytes: shareBytes! } : null,
    });
  }
  return stages;
}

/** What the next step of a suite is: a stage to start, or a verdict to report. Pure. */
export function planPoll(stages: Map<string, StageState>): {
  start: string[];
  inspection: CheckInspection;
} {
  const clone = stages.get(CLONE_CONTAINER);
  // The clone is created last, so without it the launch never finished: nothing to drive.
  if (clone === undefined) return { start: [], inspection: { kind: "gone" } };
  const setupCount = [...stages.keys()].filter((s) => /^setup-\d+$/.test(s)).length;
  const exited = (s: StageState) => s.status === "exited" || s.status === "dead";

  const sequence = [
    CLONE_CONTAINER,
    ...Array.from({ length: setupCount }, (_, i) => setupContainer(i)),
  ];
  for (const [i, stage] of sequence.entries()) {
    const state = stages.get(stage);
    const cloneDone = i > 0;
    if (state === undefined) {
      return {
        start: [],
        inspection: {
          kind: "setup_failed",
          cloneDone,
          step: i === 0 ? "clone" : i - 1,
          exitCode: null,
          why: `the ${stage} container is missing`,
        },
      };
    }
    if (state.status === "created") {
      return { start: [stage], inspection: { kind: "pending", cloneDone, why: stage } };
    }
    if (!exited(state)) {
      return {
        start: [],
        inspection: { kind: "pending", cloneDone, why: stage, running: i === 0 ? "clone" : i - 1 },
      };
    }
    if (state.exitCode !== 0) {
      return {
        start: [],
        inspection: {
          kind: "setup_failed",
          cloneDone,
          step: i === 0 ? "clone" : i - 1,
          exitCode: state.exitCode,
          why: i === 0
            ? `the clone exited ${state.exitCode}`
            : `setup step ${i} exited ${state.exitCode}`,
        },
      };
    }
  }

  // Setup is done: the services and every check start together; each check waits on the
  // services itself (scripts.ts).
  const start: string[] = [];
  const checks: Record<string, CheckContainerState> = {};
  for (const state of stages.values()) {
    if (state.stage.startsWith("svc-") && state.status === "created") start.push(state.stage);
  }
  for (const state of stages.values()) {
    if (!state.stage.startsWith("check-")) continue;
    const name = state.stage.slice("check-".length);
    if (state.status === "created") {
      start.push(state.stage);
      checks[name] = { state: "waiting" };
    } else if (exited(state)) {
      checks[name] = {
        state: "exited",
        exitCode: state.exitCode,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        reason: state.oomKilled
          ? "OOMKilled"
          : state.exitCode === CHECK_POOL_EXIT
          ? poolStopReason(state.pool)
          : null,
      };
    } else {
      checks[name] = { state: "running", startedAt: state.startedAt };
    }
  }
  // A service that stopped while checks still need it: they would wait on it, or fail against it,
  // for reasons of the platform's. Every check not yet over is the platform's failure, now.
  const stopped = [...stages.values()].find((s) => s.stage.startsWith("svc-") && exited(s));
  if (stopped !== undefined) {
    const why = `service ${stopped.stage.slice("svc-".length)} stopped (exit ${stopped.exitCode}` +
      `${stopped.oomKilled ? ", OOMKilled" : ""}) before every check was done`;
    for (const [name, check] of Object.entries(checks)) {
      if (check.state === "exited") continue;
      checks[name] = platformExit(why);
      const i = start.indexOf(checkContainer(name));
      if (i !== -1) start.splice(i, 1);
    }
  }
  return {
    start,
    inspection: {
      kind: "checks",
      checks,
      done: Object.values(checks).every((c) => c.state === "exited"),
    },
  };
}

/** A check the platform failed: its exit is CHECK_PLATFORM_EXIT, and the reason says why. */
const platformExit = (why: string): CheckContainerState => ({
  state: "exited",
  exitCode: CHECK_PLATFORM_EXIT,
  startedAt: null,
  finishedAt: null,
  reason: why,
});

export function dockerCheckLauncher(
  opts: DockerOptions,
  diag: Diagnostics,
  exec: DockerExec = docker,
  now: () => number = Date.now,
): CheckLauncher {
  const deployment = deploymentId(opts);
  const ours = (name: string) => [
    "--filter",
    `label=${CHECK_LABEL}=${name}`,
    "--filter",
    `label=${DEPLOYMENT_LABEL}=${deployment}`,
  ];
  const lines = (out: string) => out.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  let warnedEgress = false;
  /** The caps with `auto` read off the daemon once; a read that fails caps nothing this launch and
   * is tried again on the next. */
  let resolvedCaps: Promise<CheckCaps> | null = null;
  const caps = (): Promise<CheckCaps> => {
    const setting = opts.checkCaps!;
    // A cpu cap set outright still needs the daemon's count, to be held under it.
    if (setting.cpus === null && setting.memoryMi !== "auto") return Promise.resolve(setting);
    resolvedCaps ??= exec(["info", "--format", "{{.NCPU}}|{{.MemTotal}}"], {
      signal: AbortSignal.timeout(10_000),
    }).then((out) => {
      const [cpus, bytes] = out.split("|").map(Number);
      const resolved = resolveCheckCaps(setting, { cpus: cpus!, memoryBytes: bytes! });
      diag.debug("check_launcher.docker.caps", { ...resolved });
      return resolved;
    }).catch((err) => {
      resolvedCaps = null;
      diag.warn("check_launcher.docker.caps_unresolved", {
        detail: "docker info did not say what the daemon has, so `auto` caps nothing this launch",
        error: err instanceof Error ? err.message : String(err),
      });
      return setting;
    });
    return resolvedCaps;
  };
  /** This process's pulls, by image: under way, or failed and not yet answered. */
  const pulls = new Map<
    string,
    { failed: string | null; startedAt: number; failedAt: number | null }
  >();

  /** An environment image the docker builder made: in this daemon's store or nowhere. */
  const localOnly = localOnlyImage;
  /**
   * What a spec's image is, judged on the image docker resolves it to (`judgeImage`): a spec's
   * images are the caller's word, and on a shared daemon another deployment's environment images
   * sit in the same store, reachable by more spellings than a check of the name can follow. Only
   * this deployment's are launched, by their resolved ids. Throws when docker could not say.
   */
  const imagePrefix = localImagePrefix(deployment);
  const judge = (image: string) => judgeImage(image, imagePrefix, (args) => exec(args));
  /** Whether a verdict is an image in the store this deployment may launch. */
  const usable = (verdict: ImageVerdict): verdict is Extract<ImageVerdict, { kind: "local" }> =>
    verdict.kind === "local" && verdict.environment !== "foreign";
  /** Whether a verdict means "gone for good": absent and spelled local-only, or spelled local-only
   * and another deployment's. One spelled as a registry's that resolves to another deployment's
   * image is met as absent instead: it is pulled, as any absent registry image is. */
  const goneFor = (image: string, verdict: ImageVerdict) =>
    verdict.kind === "absent" ||
    (verdict.kind === "local" && verdict.environment === "foreign" && localOnly(image));

  /** Starts one image's pull, unless one is under way; it ends in `pulls` as done or failed. */
  const startPull = (image: string) => {
    if (pulls.has(image)) return;
    const pull = {
      failed: null as string | null,
      startedAt: now(),
      failedAt: null as number | null,
    };
    pulls.set(image, pull);
    const signal = AbortSignal.timeout(PULL_TIMEOUT_MS);
    diag.debug("check_launcher.docker.pulling", { image });
    exec(["pull", "--quiet", image], { signal }).then(
      () => {
        pulls.delete(image);
        diag.debug("check_launcher.docker.pulled", { image });
      },
      (err) => {
        pull.failedAt = now();
        pull.failed = signal.aborted
          ? `pulling ${image} took longer than ${PULL_TIMEOUT_MS / 60_000} minutes`
          : err instanceof Error
          ? err.message
          : String(err);
        diag.warn("check_launcher.docker.pull_failed", { image, err: pull.failed });
      },
    );
  };

  /**
   * Throws unless the named volume carries this record's and this deployment's labels.
   * `docker volume create` answers an existing volume of the name as made, labels ignored, and
   * every stage then mounts it read-write behind a root chown: a name from the caller's spec must
   * never open another deployment's volume, or anybody's. The launch's own teardown has removed
   * every volume of this record first, so one left under the name is not ours.
   */
  async function assertOwnVolume(volume: string, name: string): Promise<void> {
    const [record = "", owner = ""] = (await exec([
      "volume",
      "inspect",
      "--format",
      `{{index .Labels "${CHECK_LABEL}"}}|{{index .Labels "${DEPLOYMENT_LABEL}"}}`,
      volume,
    ])).split("|");
    if (record !== name || owner !== deployment) {
      throw new Error(
        `a volume named ${volume} exists that is not this deployment's check record ${name}; ` +
          "refusing to mount it",
      );
    }
  }

  /** Everything of one record, removed in the order the daemon accepts: containers, then the
   * volumes they held, then the network. Per object, so one stuck object starves nothing. */
  async function teardown(name: string): Promise<void> {
    const failures: string[] = [];
    const attempt = async (args: string[], gone: RegExp) => {
      try {
        await exec(args);
      } catch (err) {
        if (!gone.test(String(err))) failures.push(String(err));
      }
    };
    for (const id of lines(await exec(["ps", "-aq", ...ours(name)]))) {
      // `-v`: an image that declares a VOLUME (postgres does) leaves an anonymous one behind.
      await attempt(["rm", "-fv", id], /No such container/i);
    }
    for (const volume of lines(await exec(["volume", "ls", "-q", ...ours(name)]))) {
      await attempt(["volume", "rm", "-f", volume], /no such volume/i);
    }
    for (const network of lines(await exec(["network", "ls", "-q", ...ours(name)]))) {
      await attempt(["network", "rm", network], /not found|No such network/i);
    }
    if (failures.length > 0) {
      throw new Error(`could not remove check record ${name}: ${failures.join("; ")}`);
    }
  }

  return {
    kind: "docker",

    async prepare(images: readonly string[], since: string) {
      // Failures nobody asked about while fresh: their suites settled, or went elsewhere.
      for (const [image, pull] of pulls) {
        if (pull.failedAt !== null && now() - pull.failedAt >= PULL_FAILURE_ANSWER_MS) {
          pulls.delete(image);
        }
      }
      let pulling = false;
      for (const image of images) {
        let pull = pulls.get(image);
        let verdict: ImageVerdict;
        try {
          verdict = await judge(image);
        } catch (err) {
          const refused = refusedImageSpelling(image);
          if (refused !== null) return { kind: "failed" as const, why: refused };
          // A daemon that cannot answer has not lost anything: the launch asks again.
          diag.debug("check_launcher.docker.inspect_failed", { image, err: String(err) });
          continue;
        }
        // Absent and another deployment's are one answer, so prepare tells nobody what another
        // deployment's store holds.
        if (goneFor(image, verdict)) return { kind: "gone" as const, why: notOwnImage(image) };
        if (localOnly(image)) continue;
        if (pull?.failed != null) {
          // The answer for every suite on the image that asks while it is fresh, each spending an
          // attempt on it, but only for one that has not changed since the pull STARTED: a suite
          // charged meanwhile (here, or on another replica pulling the same image off a shared
          // daemon, whose pull ends at its own time) pulls again rather than pay twice for one
          // outage. Once the image is in after all, it is no answer. A `since` that does not
          // parse charges, so nothing can loop pulling for ever.
          const changed = Date.parse(since);
          if (!(pull.startedAt < changed) && !usable(verdict)) {
            return { kind: "failed" as const, why: pull.failed };
          }
          pulls.delete(image);
          pull = undefined;
        }
        if (pull !== undefined) pulling = true;
        else if (!usable(verdict)) {
          startPull(image);
          pulling = true;
        }
      }
      return pulling ? { kind: "pulling" as const } : { kind: "ready" as const };
    },

    async launch(spec: CheckSpec): Promise<void> {
      let planOpts: DockerOptions = opts.checkCaps === undefined
        ? opts
        : { ...opts, checkCaps: await caps() };
      let plan = launchPlan(spec, planOpts);
      /** The plan on the pinned images, once they are judged. */
      let launched: ReturnType<typeof launchPlan> | null = null;
      const name = spec.name;
      // The clone is made last, so one of this record's says the launch already happened. By its
      // labels, not its name: a container called `<name>-clone` may be another deployment's or
      // nobody's suite, and taking it for ours would make this launch a silent no-op.
      const clone = await exec([
        "container",
        "inspect",
        "-f",
        `{{index .Config.Labels "${CHECK_LABEL}"}}|{{index .Config.Labels "${DEPLOYMENT_LABEL}"}}`,
        containerName(name, CLONE_CONTAINER),
      ]).then((out) => out.split("|"), () => null);
      if (clone !== null) {
        if (clone[0] === name && clone[1] === deployment) {
          diag.debug("check_launcher.docker.already_launched", { name });
          return;
        }
        throw new Error(
          `a container named ${containerName(name, CLONE_CONTAINER)} exists that is not this ` +
            `deployment's check record ${name}; refusing to launch over it`,
        );
      }
      // The run gate, as the run provisioner makes it: a confined suite reaches its clone source
      // and the egress proxy through it, and through nothing else.
      if (opts.runNetwork) {
        const ready = await ensureGate(opts, exec);
        for (const forced of ready.forced ?? []) {
          diag.warn("check_launcher.docker.gate_recreated_under_live_runs", {
            name,
            ...gateForcedWarning(forced),
          });
        }
        if (ready.state === "deferred") {
          diag.warn("check_launcher.docker.gate_recreate_deferred", {
            name,
            live: ready.live,
            detail: "the run gate no longer matches this deployment's configuration, but " +
              "confined containers are live behind it — it is remade once none are, or once it " +
              "has waited out the cap",
          });
        }
        // The suite's own services network confines like the run network, gateway included.
        planOpts = { ...planOpts, isolateGateway: ready.isolateGateway };
        plan = launchPlan(spec, planOpts);
      }
      if (Object.keys(spec.proxyEnv).length > 0 && !warnedEgress && !opts.runNetwork) {
        warnedEgress = true;
        diag.warn("check_launcher.docker.egress_not_enforced", {
          detail: "check containers are handed the egress proxy, and nothing holds them to it: " +
            "under docker they keep their default route (see the run provisioner). Use " +
            "RYPH_PROVISIONER=kubernetes for a boundary.",
        });
      }
      try {
        // Whatever an earlier launch left half-made — it never got as far as the clone.
        await teardown(name);
        // The pristine volume first: its creation time is how `poll` tells a launch still pulling
        // from one that died (LAUNCH_GRACE_MS).
        for (const args of plan.volumes) {
          await exec(args);
          await assertOwnVolume(args[args.length - 1]!, name);
        }
        if (plan.network !== null) await exec(plan.network);
        // Pulled here, not by `create`: a pull can outlast the core's launch lease, and the record
        // that says a launch is under way already exists.
        // All of them under one limit, inside the launch's own lease, so slow ones fail this
        // attempt rather than outlive it.
        const pullLimit = AbortSignal.timeout(INLINE_PULL_MS);
        // Every image pinned to the id docker resolves it to, so the stages launch on what was
        // judged and a retag meanwhile swaps nothing.
        const pinned = new Map<string, string>();
        for (const image of plan.images) {
          let verdict = await judge(image);
          if (!usable(verdict) && !goneFor(image, verdict)) {
            await exec(["pull", "--quiet", image], { signal: pullLimit });
            verdict = await judge(image);
          }
          if (!usable(verdict)) {
            // The suite's own image is met as gone (the core builds it again); a service's is
            // refused outright. Absent and another deployment's are worded alike.
            if (image === spec.image) throw new ImageGone(notOwnImage(image));
            throw new Error(`${notOwnImage(image)}; not launched`);
          }
          pinned.set(image, verdict.id);
        }
        launched = launchPlan({
          ...spec,
          image: pinned.get(spec.image)!,
          services: spec.services.map((s) => ({ ...s, image: pinned.get(s.image)! })),
        }, planOpts);
        await exec(launched.chown);
        for (const args of launched.services) await exec(args);
        for (const args of launched.setup) await exec(args);
        for (const check of launched.checks) {
          await exec(check.create);
          if (check.connect !== null) await exec(check.connect);
        }
        await exec(launched.clone);
        await exec(["start", containerName(name, CLONE_CONTAINER)]);
      } catch (err) {
        // A half-made suite holds volumes and, with services, a network from docker's small
        // address pool: take it down before rethrowing, as the run provisioner does.
        await teardown(name).catch((cleanupErr) =>
          diag.warn("check_launcher.docker.launch_cleanup_failed", {
            name,
            err: String(cleanupErr),
          })
        );
        // Removed after the check above: `--pull never` refuses it rather than ask a registry.
        const id = launched?.images[0];
        if (id !== undefined && localOnly(id) && daemonLacksImage(err, id)) {
          throw new ImageGone(notOwnImage(spec.image));
        }
        throw err;
      }
      diag.debug("check_launcher.docker.launched", {
        suiteId: spec.suiteId,
        generation: spec.generation,
        name,
        checks: spec.checks.length,
        baked: spec.bakedCheckout,
        services: spec.services.map((s) => s.name),
        runtime: opts.runtime ?? "default",
      });
    },

    async poll(name: string): Promise<CheckInspection> {
      let stages: Map<string, StageState>;
      try {
        const ids = lines(await exec(["ps", "-aq", ...ours(name)]));
        stages = ids.length === 0
          ? new Map()
          : parseStages(await exec(["inspect", "--format", INSPECT_FORMAT, ...ids]));
      } catch (err) {
        return { kind: "unknown", why: err instanceof Error ? err.message : String(err) };
      }
      const { start, inspection } = planPoll(stages);
      if (inspection.kind === "gone") {
        // No clone yet: a launch pulling its images, or one that died part-way. Its pristine
        // volume, made first, says which.
        try {
          // Only ours: a volume of the name with other labels says nothing about this launch.
          const created = await exec([
            "volume",
            "inspect",
            "--format",
            `{{.CreatedAt}}|{{index .Labels "${CHECK_LABEL}"}}|{{index .Labels "${DEPLOYMENT_LABEL}"}}`,
            pristineVolume(name),
          ]).then((out) => {
            const [at = "", record, owner] = out.split("|");
            return record === name && owner === deployment ? Date.parse(at) : NaN;
          }, () => NaN);
          if (Number.isFinite(created) && now() - created < LAUNCH_GRACE_MS) {
            return { kind: "pending", cloneDone: false, why: "launching (pulling images)" };
          }
        } catch (err) {
          return { kind: "unknown", why: err instanceof Error ? err.message : String(err) };
        }
        return { kind: "gone" };
      }
      for (const stage of start) {
        try {
          await exec(["start", containerName(name, stage)]);
        } catch (err) {
          const why = `could not start ${stage}: ${err instanceof Error ? err.message : err}`;
          diag.warn("check_launcher.docker.start_failed", { name, stage, err: String(err) });
          if (inspection.kind === "pending") {
            // A clone or setup step docker will not start is a setup that failed, now: waiting on
            // it would only wait out the deadline.
            const step = stage === CLONE_CONTAINER ? "clone" : Number(stage.slice("setup-".length));
            return {
              kind: "setup_failed",
              cloneDone: inspection.cloneDone,
              step,
              exitCode: null,
              why,
            };
          }
          if (inspection.kind === "checks" && stage.startsWith("check-")) {
            // Reported as the container that could not run, which is what it is; a service that
            // would not start is left to the checks, which wait on it and say so.
            inspection.checks[stage.slice("check-".length)] = platformExit(why);
          }
        }
      }
      if (inspection.kind === "checks") {
        for (const stage of start) {
          const check = stage.startsWith("check-") ? stage.slice("check-".length) : null;
          if (check !== null && inspection.checks[check]?.state === "waiting") {
            inspection.checks[check] = { state: "running", startedAt: null };
          }
        }
        inspection.done = Object.values(inspection.checks).every((c) => c.state === "exited");
      }
      return inspection;
    },

    async logs(name: string, container: string, maxBytes: number): Promise<string | null> {
      try {
        // By its labels before its name: a container name is the daemon's, and one called
        // `<name>-<container>` may be another deployment's, or nobody's suite at all.
        const [id = "", record = "", owner = ""] = (await exec([
          "inspect",
          "--type",
          "container",
          "-f",
          `{{.Id}}|{{index .Config.Labels "${CHECK_LABEL}"}}|{{index .Config.Labels "${DEPLOYMENT_LABEL}"}}`,
          containerName(name, container),
        ])).split("|");
        if (id === "" || record !== name || owner !== deployment) return null;
        const text = await exec(["logs", "--tail", String(LOG_TAIL_LINES), id]);
        return lastBytes(text, maxBytes);
      } catch (err) {
        if (!/No such container/i.test(String(err))) {
          diag.warn("check_launcher.docker.logs_failed", { name, container, err: String(err) });
        }
        return null;
      }
    },

    async discard(name: string): Promise<void> {
      await teardown(name);
      diag.debug("check_launcher.docker.discarded", { name });
    },

    // Containers, volumes and networks alike: a launch that died before its first container
    // leaves only volumes and a network, and the core's sweep finds records by this list alone.
    async list(): Promise<string[]> {
      const filters = [
        "--filter",
        `label=${CHECK_LABEL}`,
        "--filter",
        `label=${DEPLOYMENT_LABEL}=${deployment}`,
        "--format",
        `{{.Label "${CHECK_LABEL}"}}`,
      ];
      const names = [
        ...lines(await exec(["ps", "-a", ...filters])),
        ...lines(await exec(["volume", "ls", ...filters])),
        ...lines(await exec(["network", "ls", ...filters])),
      ];
      return [...new Set(names)];
    },
  };
}

/**
 * Removes every check record this deployment holds whose name `listLiveNames` does not answer —
 * the suites no running row owns: containers first, then volumes, then networks. Records are
 * enumerated before the live names are read, for the reason `reclaimOrphans` gives: a suite's row
 * is running before its launch creates anything, so everything listed belongs to a name the later
 * read can see.
 *
 * The core's own sweep finds the same records through `list()`, which answers containers, volumes
 * and networks alike, so the orchestrator itself does not call this; it is for a caller that holds
 * the live names without the core.
 */
export async function reclaimCheckOrphans(
  opts: DockerOptions,
  listLiveNames: () => Promise<Iterable<string>>,
  diag: Diagnostics,
  exec: DockerExec = docker,
): Promise<{ containers: number; volumes: number; networks: number }> {
  const reclaimed = { containers: 0, volumes: 0, networks: 0 };
  const filters = [
    "--filter",
    `label=${CHECK_LABEL}`,
    "--filter",
    `label=${DEPLOYMENT_LABEL}=${deploymentId(opts)}`,
  ];
  const format = (id: string) => ["--format", `${id}\t{{.Label "${CHECK_LABEL}"}}`];
  const list = async (args: string[]): Promise<Array<[string, string]>> =>
    (await exec(args)).split("\n").filter((line) => line.trim() !== "").map((line) => {
      const tab = line.indexOf("\t");
      return [line.slice(0, tab), line.slice(tab + 1)] as [string, string];
    });
  try {
    const containers = await list(["ps", "-a", ...filters, ...format("{{.ID}}")]);
    const volumes = await list(["volume", "ls", ...filters, ...format("{{.Name}}")]);
    const networks = await list(["network", "ls", ...filters, ...format("{{.ID}}")]);
    // Only now — see the doc comment on why this read must follow the listings.
    const live = new Set(await listLiveNames());
    const remove = async (
      kind: keyof typeof reclaimed,
      id: string,
      name: string,
      args: string[],
    ) => {
      try {
        await exec(args);
        reclaimed[kind]++;
      } catch (err) {
        diag.warn("check_launcher.docker.reclaim_object_failed", {
          kind,
          id,
          name,
          err: String(err),
        });
      }
    };
    for (const [id, name] of containers) {
      if (!live.has(name)) await remove("containers", id, name, ["rm", "-fv", id]);
    }
    for (const [id, name] of volumes) {
      if (!live.has(name)) await remove("volumes", id, name, ["volume", "rm", "-f", id]);
    }
    for (const [id, name] of networks) {
      if (!live.has(name)) await remove("networks", id, name, ["network", "rm", id]);
    }
  } catch (err) {
    diag.warn("check_launcher.docker.reclaim_failed", { err: String(err) });
  }
  if (reclaimed.containers + reclaimed.volumes + reclaimed.networks > 0) {
    diag.debug("check_launcher.docker.reclaimed", reclaimed);
  }
  return reclaimed;
}
