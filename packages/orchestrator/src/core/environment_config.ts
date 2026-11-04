// The deployment's environment and harness configuration, read once at boot. Pure: `env` and `fail`
// are handed in, so both composition roots read the same variables the same way — the
// `servicePolicyFromEnv` precedent.
//
// A run's image is split in two: the ENVIRONMENT (the repo's machine: OS, toolchains, a warm
// checkout) and the HARNESS layer under /opt/ryph (runner, pi, their runtimes). `harnessKind`
// picks which harness the runner drives and never an image, because every image carries every
// harness we ship — so the kinds a deployment offers are configuration here, not an image map.
//
// Invariants:
// - hard cut: `RYPH_IMAGE_<KIND>` is gone. `RYPH_AGENT_IMAGE` is the one default image
//   (universal + harness) and there is no per-kind fallback
// - `RYPH_ENVIRONMENTS` defaults OFF, and off means every run uses `RYPH_AGENT_IMAGE` exactly as
//   phase 1 does. On, the inputs a build cannot start without are refused at boot, by name,
//   rather than at the first build
// - the builder follows the provisioner unless told otherwise: an environment has to be
//   buildable where runs launch, and a backend with no builder (manual) still gets an adapter
//   that narrates and refuses rather than an absent one

import { digestOf } from "../helpers/digest.ts";

/** The harness kinds a deployment offers when `RYPH_HARNESS_KINDS` is unset. */
export const DEFAULT_HARNESS_KINDS: readonly string[] = ["pi", "echo"];

/** Where environment builds run. Mirrors the `EnvironmentBuilder` port's `kind`. */
export type EnvironmentBuilderKind =
  | "docker"
  | "kubernetes"
  | "cloud-build"
  | "manual";

/** The builders an operator may NAME. manual is only ever derived, never chosen. */
const NAMEABLE_BUILDERS = ["docker", "kubernetes", "cloud-build"] as const;

export interface EnvironmentsConfig {
  /** `RYPH_ENVIRONMENTS=on`. Off: no builds, every run on `RYPH_AGENT_IMAGE`. */
  enabled: boolean;
  /** `RYPH_ENV_BUILDER`, or the provisioner's kind when unset. */
  builder: EnvironmentBuilderKind;
  /** `RYPH_HARNESS_IMAGE`: the image stage 4 copies /opt/ryph from. Required when enabled. */
  harnessImage: string | null;
  /** `RYPH_ENV_BASE_IMAGE`: the deployment's pinned universal image. Required when enabled. */
  baseImage: string | null;
  /** `RYPH_ENV_REGISTRY`: where built images are pushed. Required for the kubernetes builder;
   * unset on docker, where the image stays in the local store. */
  registry: string | null;
  /**
   * `RYPH_ENV_BRANCH_REGISTRY`: where BRANCH builds push, apart from `registry` so that the
   * identity a branch build pushes as cannot write the default branch's images or any layer
   * cache. Required by the kubernetes builder with an authenticated registry; null elsewhere.
   */
  branchRegistry: string | null;
  /** `RYPH_ENV_REBUILD_INTERVAL` (default 6h): how often a code-only change rebuilds. */
  rebuildIntervalMs: number;
  /** `RYPH_ENV_BUILD_CONCURRENCY` (default 2): builds in flight at once, deployment-wide. */
  buildConcurrency: number;
  /** `RYPH_ENV_BUILD_TIMEOUT` (default 60m): the wall-clock cap on one build. */
  buildTimeoutMs: number;
  /**
   * `RYPH_ENV_GIT_GATEWAY_URL`: the git gateway as a build's CLONE dials it, when that is not how
   * a run dials it (RYPH_GIT_GATEWAY_URL). The kubernetes builder clones in a pod, as a run does,
   * so it needs none; the docker builders clone on this machine, where the container view
   * (`host.docker.internal`) does not resolve, so unset they use RYPH_FORGE_URL — the same
   * server as this process dials it. Null: the run's address.
   */
  buildGatewayUrl: string | null;
  /**
   * `RYPH_ENV_EGRESS_PROXY_URL`: the egress proxy as a BUILD dials it, when that is not how a run
   * dials it (RYPH_EGRESS_PROXY_URL). A Cloud Build worker is outside the cluster, so it reaches
   * the proxy at an internal load balancer's address, not its cluster DNS name. Null: the run's.
   */
  buildProxyUrl: string | null;
  /**
   * `RYPH_ENV_WARM_CHAIN` (default 4): how many incremental builds may follow one another before
   * the next is cold. Each one is a layer on top of the last holding every file it changed —
   * the checkout's changed files and whatever setup.yml rebuilt (an incremental `cargo build`
   * rewrites part of `target/`) — and a lower layer never shrinks, so the image grows with the
   * chain. The cap bounds that growth. 0: every build is cold.
   */
  warmChain: number;
}

export const DEFAULT_ENVIRONMENTS_CONFIG: EnvironmentsConfig = {
  enabled: false,
  builder: "manual",
  harnessImage: null,
  baseImage: null,
  registry: null,
  branchRegistry: null,
  rebuildIntervalMs: 6 * 60 * 60 * 1000,
  buildConcurrency: 2,
  buildTimeoutMs: 60 * 60 * 1000,
  buildGatewayUrl: null,
  buildProxyUrl: null,
  warmChain: 4,
};

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/**
 * `90s`, `60m`, `6h`, `1d` in milliseconds, or null for anything else. A bare number is refused
 * on purpose: `RYPH_ENV_BUILD_TIMEOUT=60` is minutes to one reader and seconds to the next.
 */
export function parseDuration(raw: string): number | null {
  const match = raw.trim().match(/^([0-9]+)(ms|s|m|h|d)$/);
  if (match === null) return null;
  const value = Number(match[1]) * DURATION_UNITS[match[2]];
  return value > 0 ? value : null;
}

/** A harness kind is a free label, but it rides URLs, a column and the runner's argv. */
const HARNESS_KIND = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * `RYPH_HARNESS_KINDS`: the kinds an agent may be created with, comma-separated. Default
 * `pi,echo` — pi, and the runner's built-in no-model harness that tests and smoke runs use.
 */
export function harnessKindsFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
): string[] {
  const raw = env("RYPH_HARNESS_KINDS");
  if (raw === undefined) return [...DEFAULT_HARNESS_KINDS];
  const kinds = raw.split(",").map((k) => k.trim()).filter((k) => k !== "");
  if (kinds.length === 0) fail("RYPH_HARNESS_KINDS names no harness kind");
  for (const kind of kinds) {
    if (!HARNESS_KIND.test(kind)) {
      fail(`RYPH_HARNESS_KINDS: ${JSON.stringify(kind)} is not a lowercase slug`);
    }
  }
  if (new Set(kinds).size !== kinds.length) fail("RYPH_HARNESS_KINDS names a kind twice");
  return kinds;
}

/** See `EnvironmentsConfig.buildGatewayUrl`. */
function buildGatewayUrlFromEnv(
  env: (name: string) => string | undefined,
  builder: EnvironmentBuilderKind,
): string | null {
  const named = env("RYPH_ENV_GIT_GATEWAY_URL")?.trim().replace(/\/+$/, "");
  if (named) return named;
  if (builder !== "docker") return null;
  const forge = env("RYPH_FORGE_URL")?.trim().replace(/\/+$/, "");
  return forge !== undefined && /^https?:\/\//.test(forge) ? forge : null;
}

/**
 * The environments configuration. `provisionerKind` is `RYPH_PROVISIONER` as the composition root
 * already resolved it; it decides the builder when `RYPH_ENV_BUILDER` is unset.
 */
export function environmentsConfigFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
  provisionerKind: string,
): EnvironmentsConfig {
  const switchRaw = env("RYPH_ENVIRONMENTS")?.trim().toLowerCase() ?? "off";
  if (switchRaw !== "on" && switchRaw !== "off") {
    fail(`RYPH_ENVIRONMENTS must be "on" or "off", got ${JSON.stringify(switchRaw)}`);
  }
  const enabled = switchRaw === "on";

  const named = env("RYPH_ENV_BUILDER")?.trim();
  let builder: EnvironmentBuilderKind;
  if (named !== undefined) {
    if (!(NAMEABLE_BUILDERS as readonly string[]).includes(named)) {
      fail(
        `RYPH_ENV_BUILDER must be one of ${NAMEABLE_BUILDERS.join(", ")}, ` +
          `got ${JSON.stringify(named)}`,
      );
    }
    builder = named as EnvironmentBuilderKind;
  } else if (provisionerKind === "docker" || provisionerKind === "kubernetes") {
    builder = provisionerKind;
  } else {
    builder = "manual";
  }

  const duration = (name: string, fallback: number): number => {
    const raw = env(name);
    if (raw === undefined) return fallback;
    const ms = parseDuration(raw);
    if (ms === null) {
      fail(`${name} wants a duration with a unit, e.g. 90s, 60m or 6h, got ${JSON.stringify(raw)}`);
    }
    return ms;
  };
  const concurrencyRaw = env("RYPH_ENV_BUILD_CONCURRENCY");
  const buildConcurrency = concurrencyRaw === undefined
    ? DEFAULT_ENVIRONMENTS_CONFIG.buildConcurrency
    : Number(concurrencyRaw);
  if (!Number.isInteger(buildConcurrency) || buildConcurrency < 1) {
    fail(
      `RYPH_ENV_BUILD_CONCURRENCY must be a whole number of at least 1, ` +
        `got ${JSON.stringify(concurrencyRaw)}`,
    );
  }

  const warmChainRaw = env("RYPH_ENV_WARM_CHAIN");
  const warmChain = warmChainRaw === undefined
    ? DEFAULT_ENVIRONMENTS_CONFIG.warmChain
    : Number(warmChainRaw);
  if (!Number.isInteger(warmChain) || warmChain < 0) {
    fail(
      `RYPH_ENV_WARM_CHAIN must be a whole number of at least 0, ` +
        `got ${JSON.stringify(warmChainRaw)}`,
    );
  }

  const config: EnvironmentsConfig = {
    enabled,
    builder,
    harnessImage: env("RYPH_HARNESS_IMAGE")?.trim() || null,
    baseImage: env("RYPH_ENV_BASE_IMAGE")?.trim() || null,
    registry: env("RYPH_ENV_REGISTRY")?.trim().replace(/\/+$/, "") || null,
    branchRegistry: env("RYPH_ENV_BRANCH_REGISTRY")?.trim().replace(/\/+$/, "") || null,
    rebuildIntervalMs: duration(
      "RYPH_ENV_REBUILD_INTERVAL",
      DEFAULT_ENVIRONMENTS_CONFIG.rebuildIntervalMs,
    ),
    buildConcurrency,
    buildTimeoutMs: duration("RYPH_ENV_BUILD_TIMEOUT", DEFAULT_ENVIRONMENTS_CONFIG.buildTimeoutMs),
    buildGatewayUrl: buildGatewayUrlFromEnv(env, builder),
    buildProxyUrl: env("RYPH_ENV_EGRESS_PROXY_URL")?.trim().replace(/\/+$/, "") || null,
    warmChain,
  };
  if (enabled) {
    // Refused at boot, by name: a deployment that claims environments and cannot build one would
    // otherwise queue every repo's first build and fail each of them the same way, hours later.
    if (config.harnessImage === null) {
      fail("RYPH_ENVIRONMENTS=on needs RYPH_HARNESS_IMAGE — the image /opt/ryph is copied from");
    }
    if (config.baseImage === null) {
      fail("RYPH_ENVIRONMENTS=on needs RYPH_ENV_BASE_IMAGE — the pinned universal image");
    }
    const remote = config.builder === "kubernetes" || config.builder === "cloud-build";
    if (remote && config.registry === null) {
      fail(
        `RYPH_ENVIRONMENTS=on with the ${config.builder} builder needs RYPH_ENV_REGISTRY — a ` +
          "node can only pull a built image from a registry",
      );
    }
    // A Cloud Build worker is outside the cluster: a cluster DNS name means nothing to it, so the
    // two addresses a build dials are named for it, or the first clone fails on a lookup.
    if (config.builder === "cloud-build") {
      for (
        const [name, value, what] of [
          ["RYPH_ENV_GIT_GATEWAY_URL", config.buildGatewayUrl, "the git gateway"],
          ["RYPH_ENV_EGRESS_PROXY_URL", config.buildProxyUrl, "the egress proxy"],
        ] as const
      ) {
        if (value === null) {
          fail(
            `RYPH_ENVIRONMENTS=on with the cloud-build builder needs ${name} — ${what} at an ` +
              "address a Cloud Build worker reaches (an internal load balancer)",
          );
        }
      }
    }
    // Where images come from a registry, the two a build is made of are pinned by digest: they
    // are compared to decide re-layers and base rebuilds, and frozen onto rows, and a tag that is
    // re-pushed would change what a build pulls without changing either comparison.
    if (remote) {
      for (
        const [name, value] of [
          ["RYPH_HARNESS_IMAGE", config.harnessImage],
          ["RYPH_ENV_BASE_IMAGE", config.baseImage],
        ] as const
      ) {
        if (digestOf(value) === null) {
          fail(
            `RYPH_ENVIRONMENTS=on with the ${config.builder} builder needs ${name} pinned by ` +
              `digest (…@sha256:<64 hex>), got ${JSON.stringify(value)}`,
          );
        }
      }
    }
  }
  return config;
}
