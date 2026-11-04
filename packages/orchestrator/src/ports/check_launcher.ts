// Running one check suite, as the core sees it: hand over a spec, then read back what the backend
// observed on each container. A sibling of the
// provisioner rather than a launch kind on it: a run's provisioner answers running / exited /
// unknown for an opaque handle, and a suite's verdict is per-container exit codes, per-container
// logs and staged progress (clone, setup, checks) — nothing the provisioner port can carry.
//
// A suite OUTLIVES the process that launched it, as a build does (ports/environment_builder.ts):
// the backend's record is found by a deterministic name, so any replica — the next control plane
// after a crash or a rollout — polls the pod already running instead of launching a second one.
// Reading a result does not preserve it; writing the rows does. So `discard` is its own call,
// made once the rows are written.
//
// Invariants:
// - the verdict is the exit code the BACKEND observed (pod status, `docker inspect`). Nothing
//   inside the pod can write it, and no method here accepts anything the pod says about itself
// - only the clone step sees a credential (`clone.env`); setup and check containers get the
//   egress claim and nothing else: no run token, no forge credential, no orchestrator address
// - commands travel as env values into a platform-authored entrypoint, never interpolated into
//   argv or a script

import type { RunSize, ServiceSpec } from "./provisioner.ts";

export interface CheckSpec {
  suiteId: string;
  generation: number;
  /** Deterministic record name: `ryph-check-<suiteId>-g<generation>` for the suite's shared pod,
   * `…-o<n>-<check>` for a `pod: own` check's (core/checks.ts `checkPods`), always matching
   * CHECK_RECORD_NAME, at most 52 characters (k8s Job/Secret, docker prefix). A suite of several
   * pods is several specs, one per record. */
  name: string;
  /** The digest-pinned environment image, or RYPH_AGENT_IMAGE. */
  image: string;
  clone: {
    /** The gateway member URL the head is fetched from. */
    url: string;
    /** `GIT_CONFIG_*` extraheader — ONLY the clone step sees it. */
    env: Record<string, string>;
    /** The head sha; the clone fails unless `git rev-parse HEAD` equals it. */
    commit: string;
    /** `checksCommit`, for the changed-paths list. */
    baseCommit: string;
  };
  /**
   * This repo's checkout in `image`, as the directory under `/ryph/work` the environment build
   * baked it at (its member path), or null when the image holds none for it: the default image,
   * or an environment this repo is not a member of. Set, every check moves that warm checkout to
   * the head in its own container and runs setup there. Null, setup runs once in the clone and
   * every check copies the result.
   */
  bakedCheckout: string | null;
  setup: Array<{ run: string }>;
  /** Gitignore-style patterns: what a baked check keeps of the image's ignored files (`keep` in
   * checks.yml, its default applied). Every other ignored file is removed by the move. */
  keep: string[];
  checks: Array<{ name: string; run: string; timeoutSeconds: number }>;
  /** The union of what this pod's checks name. Sidecars start after setup, or right after the
   * clone when setup runs in the check containers (a baked checkout). */
  services: ServiceSpec[];
  size: RunSize;
  /** HTTPS_PROXY… for setup and checks; {} when there is no boundary. */
  proxyEnv: Record<string, string>;
  /** Setup budget + this pod's longest check timeout + 300 s grace: the pod's hard cap. */
  deadlineSeconds: number;
}

export type CheckContainerState =
  | { state: "waiting" }
  | { state: "running"; startedAt: string | null }
  | {
    state: "exited";
    exitCode: number;
    startedAt: string | null;
    finishedAt: string | null;
    /** e.g. "OOMKilled", "DeadlineExceeded". */
    reason: string | null;
  };

export type CheckInspection =
  /** No record: never launched, or discarded. */
  | { kind: "gone" }
  /** The backend could not be asked — decide nothing. */
  | { kind: "unknown"; why: string }
  /** Scheduling, pulling, cloning or setting up. */
  | {
    kind: "pending";
    cloneDone: boolean;
    why: string | null;
    /** The stage executing right now, when one is: the clone, or a setup step's index (as
     * `setup_failed.step`). Absent while nothing runs yet: scheduling, pulling, a stage not yet
     * started. A setup step still running past the suite's deadline is the head's hang. */
    running?: "clone" | number;
  }
  /** ImagePullBackOff, or FailedScheduling past its grace. `why`: the container that cannot
   * start, in the kubelet's words, which the suite's reason carries. Null when no node takes the
   * pod: the scheduler's message names the cluster's nodes and taints, so it is `detail`, for the
   * operator's log only. */
  | { kind: "unschedulable"; why: string | null; detail?: string }
  | {
    kind: "setup_failed";
    cloneDone: boolean;
    step: "clone" | number;
    exitCode: number | null;
    why: string;
  }
  | { kind: "checks"; checks: Record<string, CheckContainerState>; done: boolean };

/** Whether a suite's images are there to launch from (`CheckLauncher.prepare`). */
export type ImagesAnswer =
  | { kind: "ready" }
  /** Being pulled: the suite waits in the queue, holding no slot and spending no attempt. */
  | { kind: "pulling" }
  /** The pull failed: a failed launch attempt, with this as its reason. */
  | { kind: "failed"; why: string }
  /** A locally built image that is no longer there (retention removed it, or a prune, or a
   * daemon reset did): no pull brings it back, so the suite needs another image rather than
   * another attempt. */
  | { kind: "gone"; why: string };

export interface CheckLauncher {
  readonly kind: "kubernetes" | "docker";
  /**
   * Where a launch would otherwise pull its own images: answers whether they are there, and
   * starts pulling the ones that are not, in the background — or that one is gone for good
   * (`gone`), an image this backend built and no registry has. Asked before every launch so a
   * cold pull never holds up the tick. Absent where the cluster pulls (kubernetes). Never throws.
   * `since`: when the asking suite last changed (its last failed attempt, or its queueing). Only a
   * pull that failed after it is its answer, so one failure costs it one attempt on every replica,
   * and its next attempt pulls again.
   */
  prepare?(images: readonly string[], since: string): Promise<ImagesAnswer>;
  /** Idempotent by `spec.name`: an existing record is success, not an error. */
  launch(spec: CheckSpec): Promise<void>;
  /** Reads the record by name from ANY replica. On docker it also starts the next stage when the
   * previous one exited 0 (idempotent; safe from any replica). Never throws: `unknown`. */
  poll(name: string): Promise<CheckInspection>;
  /** One container's log, the LAST maxBytes. Containers: "clone" | `setup-${i}` |
   * `check-${name}`. */
  logs(name: string, container: string, maxBytes: number): Promise<string | null>;
  /** Stops and removes everything of the record. Idempotent; called only after rows are
   * written. */
  discard(name: string): Promise<void>;
  /** Names of records this deployment holds (orphan sweep). */
  list(): Promise<string[]>;
}
