// The script that drives BuildKit for an environment build, shared by the backends that run
// BuildKit themselves: the kubernetes builder runs it in a rootless container under gVisor, the
// Cloud Build builder in a rootful step on a VM of its own. Same passes, same push retry, same
// result lines — so a result is read the same way whichever backend ran it
// (`readScriptResult`), and a fix to how a build pushes or reports lands on both.
//
// What differs between them is only how buildkitd starts (`daemon`), and where the work volume is,
// which both mount at `WORK`.
//
// The parts that are the same on every build are shell files in sh/ (buildkit.sh, build.sh,
// result.sh, and the registry's credential helper), behind a constants header; what is written
// here is that header and the passes, which are this build's own.
//
// Invariants:
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
// - proxy values are expanded at run time from the container's env, never written into a script

import type { AdoptSpec, BuildSpec } from "../../ports/environment_builder.ts";
import type { SetupWarning } from "../../core/setup_warnings.ts";
import {
  BAKED_TARGET,
  cloneArgs,
  cloneScript,
  ENVIRONMENT_TARGET,
  environmentDockerfile,
  MACHINE_RECORD_FILE,
  MACHINE_RECORD_TARGET,
  parseSetupWarnings,
  parseToolchains,
  pinnedDigest,
  proxyBuildArgs,
  relayerDockerfile,
  safeName,
  SETUP_WARNINGS_FILE,
  shellQuote,
  TOOLCHAINS_FILE,
  TOOLCHAINS_TARGET,
  UNIVERSAL_IMAGE_REFS,
  WARM_FILE,
  warmDockerfile,
} from "./dockerfile.ts";
import { isDigest } from "../../helpers/digest.ts";
import { shellBody, shellConstants } from "../../helpers/shell.ts";
import CREDENTIAL_HELPER_SH from "./sh/docker-credential-ryph-gke.sh" with { type: "text" };
import BUILDKIT_SH from "./sh/buildkit.sh" with { type: "text" };
import BUILD_SH from "./sh/build.sh" with { type: "text" };
import RESULT_SH from "./sh/result.sh" with { type: "text" };

/** The rootless image's own user: its home, its XDG dirs and its subuid range are this uid's. */
export const BUILDKIT_UID = 1000;

/** The volume every container (or step) of a build shares: the clones, the outer file, the log. */
export const WORK = "/work";

/** The marker a result line starts with; see the header on why a build step cannot print one. */
export const RESULT_MARKER = "@@ryph-result";

/**
 * How every layer this script pushes is compressed: the images and the registry cache alike, so
 * a layer is compressed once and its blob shared by all of them. BuildKit's default gzip runs on
 * one core per layer, and a bake is one `RUN`, so a warm cargo `target/` is one multi-GiB layer
 * that took 12 minutes to export on a 4-vCPU worker (radicle-desktop, 3.2 GiB compressed); zstd
 * uses every core and decompresses faster on pull. No `force-compression`: layers the base images
 * already pushed as gzip keep their blobs instead of being recompressed on every build.
 */
export const LAYER_COMPRESSION = "compression=zstd,compression-level=3,oci-mediatypes=true";

/** The env var carrying the spec's own NO_PROXY to the build steps (see `buildScript`). */
export const STEP_NO_PROXY = "RYPH_STEP_NO_PROXY";

/** What the script needs to know about the backend running it. */
export interface ScriptOptions {
  /** `RYPH_ENV_REGISTRY`: where default-branch images and every layer cache go. */
  registry: string;
  /** `RYPH_ENV_BRANCH_REGISTRY`: where branch images go. */
  branchRegistry: string;
  /** `gke-metadata`: a credential helper that asks the metadata server for a token on every
   * push and pull (Workload Identity on GKE, the build's service account on Cloud Build). */
  registryAuth: "gke-metadata" | "none";
  /**
   * How buildkitd starts. `rootless`: under rootlesskit, as the image's own user, which is what a
   * pod without privileges allows. `rootful`: as root, which a Cloud Build step is (measured on
   * Cloud Build: uid 0, every capability), and which gets the overlayfs snapshotter and
   * a process sandbox.
   */
  daemon: "rootless" | "rootful";
  /**
   * Where a build STEP may connect, or null to leave steps on the daemon's own network (the
   * kubernetes pod, which a NetworkPolicy already holds to the proxy). Set, steps run on a bridge
   * of their own (`STEP_SUBNET`) and the step container's firewall lets them reach this address
   * — the egress proxy, as the build dials it — and the metadata server's resolver, and nothing
   * else: not Google's APIs, which a Cloud Build worker reaches without public egress, and not
   * the metadata server's token, which would be the build's identity. Null `proxy`: no way out at
   * all. Needs a root daemon, and fails the build when the firewall cannot be set.
   */
  confineSteps: { proxy: { host: string; port: number } | null } | null;
}

/** The bridge confined build steps run on: apart from every range the VPC uses (10.x). */
export const STEP_SUBNET = "172.30.0.0/16";
const STEP_BRIDGE = "ryph0";
const STEP_CHAIN = "RYPH-STEPS";

/**
 * Where a build's images go — the environment, its baked stage, and its machine when the repo has
 * a Dockerfile: the shared registry for the default branch, the branch registry otherwise.
 */
export function imageRepository(
  opts: Pick<ScriptOptions, "registry" | "branchRegistry">,
  spec: Pick<BuildSpec, "subjectKey" | "defaultBranch">,
) {
  const registry = spec.defaultBranch ? opts.registry : opts.branchRegistry;
  return `${registry.replace(/\/+$/, "")}/${spec.subjectKey}`;
}

/** A cache scope's ref for one of the two builds. One repository, a tag per scope and stage. */
function cacheRef(registry: string, scope: string, stage: "machine" | "environment"): string {
  return `${registry.replace(/\/+$/, "")}/cache:${safeName(scope, 100)}-${stage}`;
}

/** How long the script waits for buildkitd to answer before it gives up, in whole seconds. */
const BUILDKITD_READY_SECONDS = 120;

/** How many times one pass may try its push before the build fails (sh/build.sh). */
const PUSH_ATTEMPTS = 3;

/** The credential helper (sh/docker-credential-ryph-gke.sh): Workload Identity's token, from the
 * metadata server, on every push and pull. */
export function credentialHelper(): string {
  return shellBody(CREDENTIAL_HELPER_SH);
}

/**
 * `build()` (sh/build.sh) with the constants it reads in front: one `buildctl build`, run again
 * when all that failed was talking to the registry. `confined`, it first checks the build steps'
 * network is still confined (sh/buildkit.sh). Exported for the test, which runs it against a fake
 * `buildctl`.
 */
export function buildLines(confined = false): string[] {
  return [
    shellConstants({
      RYPH_WORK: WORK,
      RYPH_PUSH_ATTEMPTS: PUSH_ATTEMPTS,
      RYPH_CONFINE_STEPS: confined ? "1" : "",
    }),
    shellBody(BUILD_SH),
  ];
}

/**
 * The constants header of `buildScript` (helpers/shell.ts): the platform's paths and limits, the
 * backend's configuration (`ScriptOptions`), and which passes this build runs, for the parts of the
 * script that are the same on every build (sh/buildkit.sh, sh/build.sh, sh/result.sh). What a pass
 * builds and pushes is written out with the passes themselves.
 */
function scriptConstants(spec: BuildSpec, opts: ScriptOptions): string {
  const confined = opts.confineSteps !== null && opts.daemon === "rootful";
  const proxy = confined ? opts.confineSteps!.proxy : null;
  const helper = opts.registryAuth === "gke-metadata";
  const hosts = [...new Set([opts.registry, opts.branchRegistry].map((r) => r.split("/")[0]))];
  return shellConstants({
    RYPH_WORK: WORK,
    RYPH_RESULT_MARKER: RESULT_MARKER,
    RYPH_BUILDKIT_UID: BUILDKIT_UID,
    RYPH_BUILDKITD_READY_SECONDS: BUILDKITD_READY_SECONDS,
    RYPH_PUSH_ATTEMPTS: PUSH_ATTEMPTS,
    RYPH_DAEMON: opts.daemon,
    RYPH_CONFINE_STEPS: confined ? "1" : "",
    RYPH_STEP_BRIDGE: STEP_BRIDGE,
    RYPH_STEP_SUBNET: STEP_SUBNET,
    RYPH_STEP_CHAIN: STEP_CHAIN,
    RYPH_STEP_PROXY_HOST: proxy?.host ?? "",
    RYPH_STEP_PROXY_PORT: proxy?.port ?? "",
    RYPH_DOCKER_CONFIG_JSON: helper
      ? JSON.stringify({ credHelpers: Object.fromEntries(hosts.map((h) => [h, "ryph-gke"])) })
      : "",
    RYPH_CREDENTIAL_HELPER: helper ? credentialHelper() : "",
    RYPH_TOOLCHAINS_FILE: TOOLCHAINS_FILE,
    RYPH_SETUP_WARNINGS_FILE: SETUP_WARNINGS_FILE,
    RYPH_RELAYER: spec.relayerFrom !== null ? "1" : "",
    RYPH_INCREMENTAL: spec.warmFrom !== null ? "1" : "",
    RYPH_MACHINE_PUSHED: spec.relayerFrom === null && spec.dockerfileFrom !== null ? "1" : "",
  });
}

/**
 * The script the buildkit container (or step) runs. Pure and exported for the test: it is the
 * contract between the control plane and BuildKit on both backends that run it. Proxy values are
 * expanded at run time from the container's env, never written into the script.
 */
export function buildScript(spec: BuildSpec, opts: ScriptOptions): string {
  const repo = imageRepository(opts, spec);
  const tag = safeName(spec.environmentId, 100);
  const relayer = spec.relayerFrom !== null;
  const warm = spec.warmFrom !== null;
  // A step's NO_PROXY is the spec's own, not the container's: that one also names the metadata
  // server, which only the credential helper has any business dialling.
  const proxy = proxyBuildArgs(spec.proxyEnv)
    .map(([key]) =>
      `--opt "build-arg:${key}=\${${key.toUpperCase() === "NO_PROXY" ? STEP_NO_PROXY : key}}"`
    )
    .join(" ");
  const cache = (stage: "machine" | "environment", write: boolean) => {
    const into = write ? spec.cacheScope.write : null;
    return [
      ...spec.cacheScope.read.map((scope) =>
        `--import-cache ${shellQuote(`type=registry,ref=${cacheRef(opts.registry, scope, stage)}`)}`
      ),
      ...(into !== null
        ? [
          `--export-cache ${
            shellQuote(
              `type=registry,ref=${
                cacheRef(opts.registry, into, stage)
              },mode=max,image-manifest=true,${LAYER_COMPRESSION}`,
            )
          }`,
        ]
        : []),
    ].join(" ");
  };
  const join = (parts: string[]) => parts.filter((part) => part !== "").join(" ");

  // sh/buildkit.sh starts the one buildkitd, sh/build.sh is `build()`; then the passes, which are
  // this build's own, then the result (sh/result.sh).
  const lines: string[] = [
    scriptConstants(spec, opts),
    shellBody(BUILDKIT_SH),
    shellBody(BUILD_SH),
  ];

  // 1. The machine, which a warm build builds too: it is what tells it whether the image it would
  // start from is still this machine. A fixed epoch, so an unchanged machine built again from the
  // cache is the same image, digest and all.
  let machine = "";
  if (!relayer) {
    if (spec.dockerfileFrom === null) {
      machine = shellQuote(spec.baseImage);
      lines.push(`machine_digest=${shellQuote(pinnedDigest(spec.baseImage))}`);
    } else {
      const dir = `${WORK}/checkout/${spec.dockerfileFrom}`;
      lines.push(
        `echo "ryph: building ${spec.dockerfileFrom}/.ryph/Dockerfile"`,
        join([
          "build",
          `--local context=${dir}`,
          `--local dockerfile=${dir}/.ryph`,
          "--opt filename=Dockerfile",
          ...UNIVERSAL_IMAGE_REFS.map((ref) =>
            `--opt ${shellQuote(`context:${ref}=docker-image://${spec.baseImage}`)}`
          ),
          proxy,
          cache("machine", true),
          `--output ${
            shellQuote(`type=image,name=${repo}:machine-${tag},push=true,${LAYER_COMPRESSION}`)
          }`,
          `--metadata-file ${WORK}/out/machine.json`,
        ]),
        `machine_digest="$(digest ${WORK}/out/machine.json)"`,
        `machine=${shellQuote(`${repo}@`)}"$machine_digest"`,
      );
      machine = '"$machine"';
    }
  }

  /** The three passes over one outer file: the environment, its baked stage, its toolchains. */
  const passes = (mode: "cold" | "warm" | "relayer"): string[] => {
    const cached = mode === "cold";
    const outer = (target: string) =>
      join([
        "build",
        `--local context=${WORK}/outer`,
        `--local dockerfile=${WORK}/outer`,
        ...(mode === "warm" ? [`--opt filename=${WARM_FILE}`] : []),
        ...(mode === "relayer" ? [] : [
          `--local checkout=${WORK}/checkout`,
          "--opt context:checkout=local:checkout",
        ]),
        `--opt target=${target}`,
        ...(mode === "relayer"
          ? [`--opt ${shellQuote(`build-arg:RYPH_BAKED=${spec.relayerFrom}`)}`]
          : mode === "warm"
          ? [`--opt ${shellQuote(`build-arg:RYPH_WARM=${spec.warmFrom}`)}`]
          : [
            `--opt build-arg:RYPH_MACHINE=${machine}`,
            '--opt "build-arg:RYPH_MACHINE_DIGEST=$machine_digest"',
          ]),
        `--opt ${shellQuote(`build-arg:RYPH_HARNESS=${spec.harnessImage}`)}`,
        proxy,
      ]);
    return [
      mode === "relayer"
        ? `echo ${shellQuote(`ryph: re-layering ${spec.relayerFrom}`)}`
        : mode === "warm"
        ? `echo ${shellQuote(`ryph: building the environment incrementally on ${spec.warmFrom}`)}`
        : 'echo "ryph: building the environment"',
      join([
        outer(ENVIRONMENT_TARGET),
        cached ? cache("environment", true) : "",
        `--output ${shellQuote(`type=image,name=${repo}:${tag},push=true,${LAYER_COMPRESSION}`)}`,
        `--metadata-file ${WORK}/out/environment.json`,
      ]),
      // The same build's lower half, under a name of its own: all cache hits, and its layers are
      // already in the repository, so the push is a manifest.
      ...(mode === "relayer" ? [] : [
        join([
          outer(BAKED_TARGET),
          cached ? cache("environment", false) : "",
          `--output ${
            shellQuote(`type=image,name=${repo}:baked-${tag},push=true,${LAYER_COMPRESSION}`)
          }`,
          `--metadata-file ${WORK}/out/baked.json`,
        ]),
      ]),
      join([
        outer(TOOLCHAINS_TARGET),
        cached ? cache("environment", false) : "",
        `--output type=local,dest=${WORK}/out/toolchains`,
      ]),
    ];
  };

  if (relayer) {
    lines.push(...passes("relayer"));
  } else if (!warm) {
    lines.push(...passes("cold"));
  } else {
    // 2–4, incrementally only when the image it starts from was built on the machine just built.
    // The record is read out by a build of its own; an image with none (older than the record)
    // or one that cannot be read is simply not this machine, and the build is cold.
    lines.push(
      "recorded=",
      join([
        "if buildctl build --progress=plain --frontend=dockerfile.v0",
        `--local context=${WORK}/outer`,
        `--local dockerfile=${WORK}/outer`,
        `--opt filename=${WARM_FILE}`,
        `--opt target=${MACHINE_RECORD_TARGET}`,
        `--opt ${shellQuote(`build-arg:RYPH_WARM=${spec.warmFrom}`)}`,
        // Unused by this target, but the frontend resolves every stage's FROM.
        `--opt ${shellQuote(`build-arg:RYPH_HARNESS=${spec.harnessImage}`)}`,
        `--output type=local,dest=${WORK}/out/record`,
        `> ${WORK}/out/record.log 2>&1; then`,
      ]),
      `  recorded="$(cat ${WORK}/out/record/${MACHINE_RECORD_FILE} 2>/dev/null || :)"`,
      "else",
      // A record that could not be read is not a changed machine; say which it was.
      `  echo "== the image this would build on could not be read; building from scratch"`,
      `  tail -n 5 ${WORK}/out/record.log || :`,
      "fi",
      'if [ -n "$machine_digest" ] && [ "$recorded" = "$machine_digest" ]; then',
      "  warm=1",
      ...passes("warm").map((line) => `  ${line}`),
      "else",
      "  warm=0",
      // Not a `ryph:` line: `failureLine` reads those as the reason a build failed.
      '  if [ -n "$recorded" ]; then',
      `    echo "== the machine changed since the image this would build on; building from scratch"`,
      "  else",
      `    echo "== the image this would build on records no machine; building from scratch"`,
      "  fi",
      ...passes("cold").map((line) => `  ${line}`),
      "fi",
    );
  }
  lines.push(shellBody(RESULT_SH));
  return lines.join("\n") + "\n";
}

/** The init container's script: the outer Dockerfile onto the volume, then the clones, whose
 * values are its arguments (`initArgs`). */
export function initScript(spec: BuildSpec): string {
  const relayer = spec.relayerFrom !== null;
  // Base64, so each file crosses the shell as one word whatever it contains. A warm build gets
  // the full file too: it builds that one when the machine changed under it.
  const files: Array<[string, string]> = relayer ? [["Dockerfile", relayerDockerfile()]] : [
    ["Dockerfile", environmentDockerfile()],
    ...(spec.warmFrom !== null ? [[WARM_FILE, warmDockerfile()] as [string, string]] : []),
  ];
  return [
    "set -euo pipefail",
    `mkdir -p ${WORK}/checkout ${WORK}/outer ${WORK}/out ${WORK}/home ${WORK}/buildkit`,
    ...files.map(([name, text]) =>
      `printf '%s' ${shellQuote(btoa(text))} | base64 -d > ${WORK}/outer/${name}`
    ),
    ...(relayer ? [] : [`cd ${WORK}/checkout`, cloneScript()]),
  ].join("\n");
}

/** `initScript`'s arguments: what the clone clones (`cloneArgs`), or nothing for a re-layer. */
export function initArgs(spec: BuildSpec): string[] {
  return spec.relayerFrom !== null ? [] : cloneArgs(spec);
}

/** Every value result lines carried for `key`, in order. */
export function resultLines(log: string, key: string): string[] {
  const prefix = `${RESULT_MARKER} ${key} `;
  return log.split("\n").filter((line) => line.startsWith(prefix)).map((line) =>
    line.slice(prefix.length).trim()
  );
}

/** What a finished script printed, as the parts of a result — or why it cannot be one. */
export type ScriptResult =
  | {
    ok: true;
    image: string;
    bakedImage: string;
    /** The machine image this build pushed, or null where it pushed none. */
    machineImage: string | null;
    toolchains: Record<string, string>;
    /** The repos whose setup.yml did not finish at bake time; empty when all did. */
    setupWarnings: SetupWarning[];
    /** Whether an incremental build really started from its image (the machine had not
     * changed). Absent where the script said nothing — every other build, and one started by a
     * control plane from before this line existed — which the core reads as "as asked". */
    warm?: boolean;
  }
  | { ok: false; message: string };

/**
 * The result lines of a script that ran to its end, read into images. The digests become
 * `<repository>@<digest>` for the registry this build pushed to; a re-layer answers the baked
 * image it was given, since it built none.
 *
 * The script prints every key once (`buildScript`), so a key that appears twice is a line the
 * script did not print, and the build fails rather than pick one: on a backend whose RUN steps
 * can reach the log the result is read from (kubernetes, without a process sandbox), "the last
 * one wins" would be a forger's rule too. A key absent is read as `none`, as for a build started
 * by a control plane that printed fewer.
 */
export function readScriptResult(
  log: string,
  spec: Pick<AdoptSpec, "subjectKey" | "defaultBranch" | "relayerFrom">,
  opts: Pick<ScriptOptions, "registry" | "branchRegistry">,
): ScriptResult {
  const keys = ["digest", "baked", "machine", "warm", "toolchains", "setup-warnings"] as const;
  const values = new Map<string, string | null>();
  for (const key of keys) {
    const found = resultLines(log, key);
    if (found.length > 1) {
      return {
        ok: false,
        message: `the build reported its ${key} more than once, so its result cannot be trusted`,
      };
    }
    values.set(key, found[0] === undefined || found[0] === "none" ? null : found[0]);
  }
  const pinned = (digest: string | null | undefined) => isDigest(digest) ? digest : null;
  const digest = pinned(values.get("digest"));
  const warmLine = values.get("warm") ?? null;
  if (digest === null) {
    return { ok: false, message: "the build finished but reported no image digest" };
  }
  const repository = imageRepository(opts, spec);
  let bakedImage = spec.relayerFrom;
  if (bakedImage === null) {
    const baked = pinned(values.get("baked"));
    if (baked === null) {
      return {
        ok: false,
        message: "the build finished but reported no digest for its baked stage",
      };
    }
    bakedImage = `${repository}@${baked}`;
  }
  const machine = pinned(values.get("machine"));
  return {
    ok: true,
    image: `${repository}@${digest}`,
    bakedImage,
    machineImage: machine === null ? null : `${repository}@${machine}`,
    toolchains: parseToolchains(values.get("toolchains") ?? "{}"),
    // Absent is a result cut before its last line: unknown, so unreadable — never clean.
    setupWarnings: parseSetupWarnings(values.get("setup-warnings") ?? ""),
    warm: warmLine === null ? undefined : warmLine === "1",
  };
}
