// The environment builder a deployment gets, from its configuration: which backend
// (`EnvironmentsConfig.builder`, following the provisioner unless RYPH_ENV_BUILDER says otherwise)
// and the few knobs only that backend reads. Shared by both composition roots, like
// `kubernetesOptionsFromEnv`, so the two cannot read the same variables differently.
//
// Invariants:
// - every backend gets an adapter, never an absent one: manual narrates and refuses, with a
//   reason the environment page can show
// - a backend's own knobs are read here and nowhere else, and a bad one is a boot failure, named

import type { EnvironmentBuilder } from "../../ports/environment_builder.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import type { EnvironmentsConfig } from "../../core/environment_config.ts";
import { parseRunSizes, type RunSize } from "../../core/run_sizes.ts";
import { kubernetesOptionsFromEnv } from "../provisioner/kubernetes.ts";
import { type CommandRunner, dockerEnvironmentBuilder } from "./docker.ts";
import {
  DEFAULT_BUILDKIT_IMAGE,
  kubernetesEnvironmentBuilder,
  UNSANDBOXED_BUILDS_REFUSED,
} from "./kubernetes.ts";
import { cloudBuildEnvironmentBuilder, DEFAULT_ROOTFUL_BUILDKIT_IMAGE } from "./cloud_build.ts";
import { manualEnvironmentBuilder } from "./manual.ts";
import { deploymentId, type DockerOptions } from "../provisioner/docker.ts";

export type { CommandRunner } from "./docker.ts";

/** Where builder Jobs go, and who they run as, unless configured otherwise. */
export const DEFAULT_BUILD_NAMESPACE = "ryph-builds";
export const DEFAULT_BUILD_SERVICE_ACCOUNT = "ryph-builder";
export const DEFAULT_BRANCH_BUILD_SERVICE_ACCOUNT = "ryph-branch-builder";

/**
 * A build pod's resources when `RYPH_ENV_BUILD_SIZE` is unset. The disk is a volume, not the
 * pod's ephemeral storage: BuildKit's state for a warm Rust environment is tens of gigabytes, and
 * GKE Autopilot caps a pod's ephemeral storage at 10Gi.
 */
export const DEFAULT_BUILD_SIZE_SPEC = "cpu=4,memory=8Gi,ephemeral-storage=10Gi,work-volume=50Gi";

export interface EnvironmentBuilderDeps {
  diag?: Diagnostics;
  /** The process environment; defaults to process.env. */
  env?: (name: string) => string | undefined;
  /** How a bad knob stops the boot; defaults to throwing. */
  fail?: (message: string) => never;
  /** Injected for tests. */
  fetch?: typeof fetch;
  run?: CommandRunner;
  /**
   * The docker provisioner's options, as the composition root launches runs with them. With a
   * `runNetwork`, runs are confined, and so is every docker build (docker.ts, "CONFINED BUILDS").
   */
  docker?: DockerOptions;
  /**
   * Whether the docker builder takes a build's `defaultBranch` at its caller's word where runs are
   * sandboxed (docker.ts, `trustDefaultBranch`). The process that runs the builder decides, never
   * a request: the binary's embedded launcher, whose caller is itself, says yes; a standalone
   * launcher only on RYPH_ENV_TRUST_DEFAULT_BRANCH=on. Default no.
   */
  trustDefaultBranch?: boolean;
  /**
   * Whether the docker builder may build unconfined, where runs are not confined. An unconfined
   * build tags the universal image's public names on the daemon (docker.ts, "NAMED IMAGE
   * CONTEXTS"), names every build on that daemon reads, so only a builder whose deployment is the
   * daemon's one tenant may: the binary's embedded launcher. Default no: a builder with no run
   * network refuses every build (`everyBuildRefused`).
   */
  soleTenant?: boolean;
}

/** The runtime runs are sandboxed by, or null: runc by either of its names is no sandbox. */
export function sandboxedRuntime(runtime: string | undefined): string | null {
  const named = runtime?.trim();
  return named && !/^(io\.containerd\.)?runc(\.v2)?$/.test(named) ? named : null;
}

/** Why an unconfined docker build is refused where the builder is not the daemon's one tenant. */
export const UNCONFINED_BUILDS_REFUSED =
  "runs are not confined (RYPH_DOCKER_RUN_NETWORK is unset), and an unconfined build tags the " +
  "universal image's public names, which every deployment on this docker daemon builds on. " +
  "Set RYPH_DOCKER_RUN_NETWORK on the launcher to confine runs and builds";

/**
 * Why the docker builder refuses EVERY build, or null when it builds some. Unconfined (no
 * `runNetwork`), a builder that is not the daemon's one tenant (`soleTenant`) refuses them all
 * (`UNCONFINED_BUILDS_REFUSED`). Runs sandboxed by `runtime` refuse branch builds, and a builder
 * that does not take its caller's word for a default-branch build (`trustDefaultBranch`) cannot
 * tell one from the other, so refuses them all. A launcher says this in /v1/info so a caller with
 * builds on refuses to boot rather than fail every build later. Each reason names its remedy.
 */
export function everyBuildRefused(opts: {
  runtime: string | undefined;
  runNetwork: string | undefined;
  trustDefaultBranch: boolean;
  soleTenant: boolean;
}): string | null {
  if (opts.runNetwork === undefined && !opts.soleTenant) return UNCONFINED_BUILDS_REFUSED;
  const sandboxed = sandboxedRuntime(opts.runtime);
  if (sandboxed === null || opts.trustDefaultBranch) return null;
  return `runs are sandboxed by RYPH_DOCKER_RUNTIME=${sandboxed}, which refuses branch builds, ` +
    "and RYPH_ENV_TRUST_DEFAULT_BRANCH is off, so no build is taken for the default branch's. " +
    "Set RYPH_ENV_TRUST_DEFAULT_BRANCH=on on the launcher to build the default branch, or unset " +
    "RYPH_DOCKER_RUNTIME there";
}

/** `RYPH_ENV_BUILD_SIZE`, in the size-class grammar without a name: `cpu=4,memory=8Gi,…`. */
export function buildSizeFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
): RunSize {
  const raw = env("RYPH_ENV_BUILD_SIZE") ?? DEFAULT_BUILD_SIZE_SPEC;
  const parsed = parseRunSizes(`build:${raw}`, "build");
  if (!parsed.ok) fail(parsed.error.replace("RYPH_RUN_SIZES", "RYPH_ENV_BUILD_SIZE"));
  return parsed.sizes.classes[0];
}

/**
 * How the kubernetes builder authenticates to the registry: `RYPH_ENV_REGISTRY_AUTH`, or — unset —
 * Workload Identity for a Google registry and nothing for any other.
 */
export function registryAuthFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
  registry: string,
): "gke-metadata" | "none" {
  const raw = env("RYPH_ENV_REGISTRY_AUTH")?.trim();
  if (raw === undefined || raw === "") {
    const host = registry.split("/")[0];
    return host.endsWith(".pkg.dev") || host === "gcr.io" || host.endsWith(".gcr.io")
      ? "gke-metadata"
      : "none";
  }
  if (raw !== "gke-metadata" && raw !== "none") {
    fail(`RYPH_ENV_REGISTRY_AUTH must be "gke-metadata" or "none", got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/** `RYPH_ENV_BUILD_ALLOW_UNSANDBOXED`: `on` lets kubernetes builds run with no runtime class. */
export function allowUnsandboxedFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
): boolean {
  const raw = env("RYPH_ENV_BUILD_ALLOW_UNSANDBOXED")?.trim().toLowerCase() || "off";
  if (raw !== "on" && raw !== "off") {
    fail(`RYPH_ENV_BUILD_ALLOW_UNSANDBOXED must be "on" or "off", got ${JSON.stringify(raw)}`);
  }
  return raw === "on";
}

/** The docker builder's cache root: RYPH_ENV_CACHE_DIR, else the user's cache dir, else none. */
export function cacheDirFromEnv(env: (name: string) => string | undefined): string | null {
  const explicit = env("RYPH_ENV_CACHE_DIR")?.trim();
  if (explicit) return explicit;
  const base = env("XDG_CACHE_HOME") ?? (env("HOME") ? `${env("HOME")}/.cache` : undefined);
  return base ? `${base}/ryph/environments` : null;
}

const silent: Diagnostics = { debug() {}, warn() {} };

/**
 * `RYPH_ENV_IMAGE_REMOVAL`: `on` (the default) or `off`, the stop for everything retention deletes
 * — a retired build's images, a registry's replaced cache exports, its untagged leftovers. Off,
 * the builder answers as one that cannot remove anything, and the core leaves every row unstamped
 * for whenever it is on again. On every backend, docker included: an operator who has to stop
 * deletion to find out what went wrong wants it stopped wherever it happens.
 */
export function imageRemovalFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
): boolean {
  const raw = env("RYPH_ENV_IMAGE_REMOVAL")?.trim().toLowerCase() || "on";
  if (raw !== "on" && raw !== "off") {
    fail(`RYPH_ENV_IMAGE_REMOVAL must be "on" or "off", got ${JSON.stringify(raw)}`);
  }
  return raw === "on";
}

/** The builder without anything that deletes, for RYPH_ENV_IMAGE_REMOVAL=off. */
function withoutRemoval(builder: EnvironmentBuilder): EnvironmentBuilder {
  const {
    removeImages: _removeImages,
    pruneCache: _pruneCache,
    reconcileImages: _reconcileImages,
    removalStats: _removalStats,
    ...rest
  } = builder;
  return rest;
}

export function createEnvironmentBuilder(
  config: EnvironmentsConfig,
  deps: EnvironmentBuilderDeps = {},
): EnvironmentBuilder {
  const env = deps.env ?? ((name: string) => process.env[name]);
  const fail = deps.fail ?? ((message: string): never => {
    throw new Error(message);
  });
  const builder = createBuilder(config, deps, env, fail);
  if (imageRemovalFromEnv(env, fail)) return builder;
  (deps.diag ?? silent).warn("environment_builder.image_removal_off", {
    why: "RYPH_ENV_IMAGE_REMOVAL=off: no image, cache export or untagged version is deleted",
  });
  return withoutRemoval(builder);
}

function createBuilder(
  config: EnvironmentsConfig,
  deps: EnvironmentBuilderDeps,
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
): EnvironmentBuilder {
  const diag = deps.diag ?? silent;

  switch (config.builder) {
    case "docker": {
      // A build runs code a patch can change, so it is confined wherever runs are: on docker's
      // run network, through the same gate.
      const docker = deps.docker?.runNetwork !== undefined ? deps.docker : null;
      if (docker !== null && docker.gate === undefined) {
        fail("confined docker builds need the run gate (RYPH_DOCKER_GATE_IMAGE)");
      }
      // A confined build reaches the run gate alone, at the run proxy's port; an override names
      // either something it cannot reach or a port the gate does not relay. Refused, not ignored:
      // a setting that reads as configured and does nothing is how a boot misleads. This holds
      // where `config` is the caller's own, the embedded launcher's; a standalone launcher is
      // handed the proxy in each build spec, and its caller is refused the setting at boot
      // instead (`launcherCallerRefusal`).
      if (docker !== null && config.buildProxyUrl !== null) {
        fail(
          "RYPH_ENV_EGRESS_PROXY_URL is unused when docker builds are confined: a confined build " +
            "reaches only the run gate, at RYPH_EGRESS_PROXY_URL. Unset it.",
        );
      }
      // The kubernetes builder's image is often rootless; the docker-container driver runs
      // BuildKit privileged and needs a rootful one, so a copied setting fails every build.
      const buildkitImage = env("RYPH_ENV_BUILDKIT_IMAGE")?.trim() ||
        DEFAULT_ROOTFUL_BUILDKIT_IMAGE;
      if (docker !== null && /rootless/.test(buildkitImage)) {
        fail(
          `RYPH_ENV_BUILDKIT_IMAGE=${buildkitImage} is rootless; a confined docker build runs a ` +
            "rootful BuildKit. Unset it for the pinned default, or name a rootful image.",
        );
      }
      // A sandboxed runtime is a boundary a build never gets (docker.ts, "CONFINED BUILDS").
      const sandboxed = sandboxedRuntime(deps.docker?.runtime);
      return dockerEnvironmentBuilder(
        {
          cacheDir: cacheDirFromEnv(env),
          tempRoot: env("RYPH_ENV_TEMP_DIR")?.trim() || undefined,
          platform: env("RYPH_ENV_BUILD_PLATFORM")?.trim() || undefined,
          confine: docker === null ? undefined : { docker, buildkitImage },
          // The runs' deployment, confined or not: its images are the only ones a build reads.
          deployment: deploymentId(deps.docker ?? {}),
          refuseBranchBuilds: sandboxed !== null
            ? `runs are sandboxed by the ${sandboxed} runtime, and a build runs under runc, so a ` +
              "branch's .ryph/ would build outside that sandbox"
            : undefined,
          trustDefaultBranch: deps.trustDefaultBranch ?? false,
          refuseUnconfined: docker === null && deps.soleTenant !== true
            ? UNCONFINED_BUILDS_REFUSED
            : undefined,
        },
        diag,
        { run: deps.run },
      );
    }
    case "kubernetes": {
      const registry = config.registry ??
        fail("the kubernetes environment builder needs RYPH_ENV_REGISTRY");
      const registryAuth = registryAuthFromEnv(env, fail, registry);
      // A branch build pushes somewhere the default branch's builds never read from. Where the
      // push needs a credential, a RUN step can reach it (kubernetes.ts), so the two must be
      // apart; an open registry has nothing to steal and may be the same one.
      const branchRegistry = config.branchRegistry ?? registry;
      if (registryAuth !== "none" && branchRegistry === registry) {
        fail(
          "the kubernetes environment builder with an authenticated registry needs " +
            "RYPH_ENV_BRANCH_REGISTRY, a registry apart from RYPH_ENV_REGISTRY that branch " +
            "builds push to (docs/environment-builders.md)",
        );
      }
      // The API connection is the provisioner's: same variables, same in-pod defaults.
      const k8s = kubernetesOptionsFromEnv(env, fail);
      // A build runs repo-authored code exactly as a run does, so it gets the run's boundary
      // unless one of its own is named — and, its BuildKit unconfined, it gets one or none at all.
      const runtimeClass = env("RYPH_ENV_BUILD_RUNTIME_CLASS")?.trim() || k8s.runtimeClass;
      const allowUnsandboxed = allowUnsandboxedFromEnv(env, fail);
      if (!runtimeClass && !allowUnsandboxed) fail(UNSANDBOXED_BUILDS_REFUSED);
      if (!runtimeClass) {
        diag.warn("environment_builder.unsandboxed", {
          why: "RYPH_ENV_BUILD_ALLOW_UNSANDBOXED=on: builds run on the node's own kernel",
        });
      }
      return kubernetesEnvironmentBuilder(
        {
          apiUrl: k8s.apiUrl,
          tokenFile: k8s.tokenFile,
          caFile: k8s.caFile,
          namespace: env("RYPH_ENV_BUILD_NAMESPACE")?.trim() || DEFAULT_BUILD_NAMESPACE,
          serviceAccount: env("RYPH_ENV_BUILD_SERVICE_ACCOUNT")?.trim() ||
            DEFAULT_BUILD_SERVICE_ACCOUNT,
          branchServiceAccount: env("RYPH_ENV_BRANCH_BUILD_SERVICE_ACCOUNT")?.trim() ||
            DEFAULT_BRANCH_BUILD_SERVICE_ACCOUNT,
          runtimeClass,
          allowUnsandboxed,
          registry,
          branchRegistry,
          buildkitImage: env("RYPH_ENV_BUILDKIT_IMAGE")?.trim() || DEFAULT_BUILDKIT_IMAGE,
          snapshotter: env("RYPH_ENV_BUILDKIT_SNAPSHOTTER")?.trim() || undefined,
          size: buildSizeFromEnv(env, fail),
          volumeClass: k8s.workVolumeClass,
          registryAuth,
        },
        diag,
        { fetch: deps.fetch },
      );
    }
    case "cloud-build": {
      const required = (name: string) =>
        env(name)?.trim() || fail(`the cloud-build environment builder needs ${name}`);
      const registry = config.registry ??
        fail("the cloud-build environment builder needs RYPH_ENV_REGISTRY");
      // Two identities, two registries, for the kubernetes builder's reason: a RUN step can reach
      // its build's token, so a branch build's must not be able to write the shared registry.
      const branchRegistry = config.branchRegistry ?? registry;
      if (branchRegistry === registry) {
        fail(
          "the cloud-build environment builder needs RYPH_ENV_BRANCH_REGISTRY, a registry apart " +
            "from RYPH_ENV_REGISTRY that branch builds push to (docs/environment-builders.md)",
        );
      }
      const disk = env("RYPH_ENV_CLOUD_BUILD_DISK")?.trim() || null;
      return cloudBuildEnvironmentBuilder(
        {
          pool: required("RYPH_ENV_CLOUD_BUILD_POOL"),
          logsBucket: required("RYPH_ENV_CLOUD_BUILD_LOGS").replace(/^gs:\/\//, ""),
          branchLogsBucket: required("RYPH_ENV_CLOUD_BUILD_BRANCH_LOGS").replace(/^gs:\/\//, ""),
          serviceAccount: required("RYPH_ENV_CLOUD_BUILD_SERVICE_ACCOUNT"),
          branchServiceAccount: required("RYPH_ENV_CLOUD_BUILD_BRANCH_SERVICE_ACCOUNT"),
          registry,
          branchRegistry,
          buildkitImage: env("RYPH_ENV_BUILDKIT_IMAGE")?.trim() || DEFAULT_ROOTFUL_BUILDKIT_IMAGE,
          disk,
        },
        diag,
        { fetch: deps.fetch },
      );
    }
    case "manual":
      return manualEnvironmentBuilder(diag);
  }
}
