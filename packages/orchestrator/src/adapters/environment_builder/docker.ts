// The docker `EnvironmentBuilder`: `docker buildx build` on this machine, for the binary and for
// laptops. No registry — the image stays in the local store, and its image id is the digest a run
// freezes.
//
// One environment is up to four builds, each a plain CLI call whose argv is pinned by the test:
//   1. the machine, when the repo has a `.ryph/Dockerfile`: that file, with the repo checkout as
//      its context — so `COPY rust-toolchain.toml` works, and `.ryph/Dockerfile.dockerignore` is
//      honoured by BuildKit itself — tagged locally for step 2 to build on
//   2. the environment: the generated outer Dockerfile (dockerfile.ts) on top of that machine, or
//      of the universal image, with the clones as the `checkout` context
//   3. the `baked` target of the same file, tagged: all cache hits, and what a later re-layer
//      builds FROM
//   4. the `toolchains` target, exported to a directory: every stage is a cache hit by then, and
//      it reads the record ryph-bake wrote without starting the image
// A RE-LAYER (`relayerFrom`) is 2 and 4 alone, on the re-layer file: no clone, no cache. A WARM
// build (`warmFrom`) is 2, 3 and 4 on the warm file: a clone, but no machine and no cache.
//
// The clone happens first, on the host, into a temporary directory, with the build's git
// credential in git's env and nowhere else. Nothing inside a build ever holds it.
//
// What this driver cannot do, said here once:
// - NAMED IMAGE CONTEXTS. The `docker` buildx driver resolves `--build-context x=docker-image://…`
//   against a registry and never against the local store (measured, engine 29.4: a local-only
//   `ryph-universal:dev` is "pull access denied"), and it refuses `oci-layout://` outright. A
//   plain `FROM` does read the local store. So the universal image's public name is mapped to the
//   deployment's pinned copy by TAGGING it under that name locally — the one place this backend
//   rewrites a tag it does not own — and the outer file names its inputs by build argument.
//   Those names are read by every build on the daemon, so only a builder whose deployment is the
//   daemon's one tenant may write them (the binary's embedded launcher): any other is handed
//   `refuseUnconfined` and builds only confined, where the names map by named context instead.
// - SCOPED CACHE, unless the daemon uses the containerd image store. The classic store cannot
//   export a BuildKit cache at all, so there the daemon's own shared build cache is what makes a
//   rebuild fast, and branch and default builds share it. Accepted for a laptop, where every
//   build is the operator's own; with the containerd store, each scope gets a directory under
//   `cacheDir` and a branch build writes none.
//
// What a build leaves is cleaned up here or by the core. A finished environment's two tags stay
// until retention retires the row and the core asks `removeImages`; a build that fails untags what
// it had tagged, and `adopt` does for one that died with its process; each cache export is a
// version of its own, deleted once no build can still be reading it (`scopeDir`). What stays the
// daemon's to clean: its own build cache, and the base images pulled. A scope nobody builds any
// more keeps its current version.
//
// CONFINED BUILDS (`confine`, when the deployment confines its docker runs). A build runs
// repo-authored code — `.ryph/Dockerfile`'s RUN steps and setup.yml — that a patch can change, so
// it gets the boundary a run gets or the run's boundary is worth nothing: a confined agent would
// edit setup.yml, submit, and have its build reach what it cannot. The `docker` driver's RUN steps
// take the daemon's default bridge (the internet, the LAN and, on Docker Desktop, the host's
// loopback), and it cannot be given another network: "network mode … not supported by buildkit"
// (measured, engine 29.8). So a confined build gets a BuildKit of its own — a `docker-container`
// builder on an internal network of the build's own with the run gate attached, both made for the
// build and removed after it — whose RUN steps share its network namespace and therefore its
// confinement: no route out, no host, and the run gate as the only thing to talk to. Not the run
// network itself: a RUN step is root with BuildKit's default capabilities (raw sockets among them),
// which every run has dropped, and there it would sit beside the runs. The egress proxy behind the gate, on the build's claim,
// is their way out and BuildKit's own (a `FROM` a `.ryph/Dockerfile` names is pulled through it).
// What that costs, measured on Docker Desktop:
//   · RUN steps resolve nothing: BuildKit hands them public resolvers in place of the container's
//     own, which an internal network cannot reach. So the proxy is named by the gate's ADDRESS on
//     the build's network, read at the start of the build — the proxy resolves every name itself
//   · the builder cannot read the daemon's image store, so every image a pass starts from (the
//     base, the harness, a warm or baked image) is exported first and handed over as an
//     `oci-layout://` named context, and the machine is written out as one. Results come back
//     with `--load`, and the layer cache is always the scoped directories under `cacheDir`, which
//     this driver can always export — so a branch build reads the default scope and writes none,
//     and no build reads the daemon's shared cache
// A deployment whose runs have a sandboxed runtime (RYPH_DOCKER_RUNTIME) refuses branch builds
// (`refuseBranchBuilds`), confined or not: a default-branch build runs code that was merged, a
// branch build runs code an agent wrote, and a build runs under runc whatever that says —
// confined, in a privileged BuildKit container — so it never gets the run's sandbox. Which branch
// a build is of is its caller's word (`BuildSpec.defaultBranch`, beside the clone URLs and the
// commit it also names), so it counts only where the caller is trusted (`trustDefaultBranch`):
// the binary, whose launcher is in its own process. A standalone launcher that is not told to
// trust it refuses every build under a sandboxed runtime, since a compromised control plane
// could otherwise call any repository's branch the default and RUN it under runc.

import { isDigest } from "../../helpers/digest.ts";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "@ryph/process";
import type {
  AdoptResult,
  BuildResult,
  BuildSpec,
  EnvironmentBuilder,
  RemoveImagesSpec,
} from "../../ports/environment_builder.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import {
  confinedNetworkFlags,
  DEPLOYMENT_LABEL,
  deploymentId,
  type DockerOptions,
  ensureGate,
  gateForcedWarning,
  gateName,
  type GateReady,
} from "../provisioner/docker.ts";
import {
  confinedBuilderPrefixFor,
  localImagePrefix,
  noEnvironmentImageRef,
  notOwnImage,
  ownImageRef,
} from "./local_images.ts";
import {
  assertBuildable,
  BAKED_TARGET,
  BuildLog,
  cloneArgs,
  cloneScript,
  ENVIRONMENT_TARGET,
  environmentDockerfile,
  failureLine,
  logTail,
  MACHINE_RECORD_FILE,
  MACHINE_RECORD_TARGET,
  parseSetupWarnings,
  parseToolchains,
  pinnedDigest,
  proxyBuildArgs,
  relayerDockerfile,
  safeName,
  SETUP_WARNINGS_FILE,
  TOOLCHAINS_FILE,
  TOOLCHAINS_TARGET,
  UNIVERSAL_IMAGE_REFS,
  UNIVERSAL_IMAGE_TAGS,
  WARM_FILE,
  warmDockerfile,
} from "./dockerfile.ts";

/** One finished command: its exit code and both streams. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs one program. Injected so the test can pin every argv without a docker daemon; the real one
 * is `runCommand` below. Aborting the signal kills the child — how a timeout or a cancel stops a
 * build, since a buildx client that goes away takes its solve with it.
 */
export type CommandRunner = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; signal: AbortSignal },
) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (cmd, args, opts) => {
  const { code, stdout, stderr } = await command(cmd, {
    args,
    cwd: opts.cwd,
    env: opts.env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal: opts.signal,
  }).output();
  const decoder = new TextDecoder();
  return { code, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) };
};

export interface DockerBuilderOptions {
  /**
   * Where per-scope BuildKit caches live (`RYPH_ENV_CACHE_DIR`). Used only when the daemon can
   * export a cache (the containerd image store); see the header.
   */
  cacheDir: string | null;
  /**
   * Where the clone, the generated file and the image exports go while a build runs
   * (`RYPH_ENV_TEMP_DIR`), made if missing. Unset: the system temp dir. The exports of a confined
   * build are GBs, so a RAM-backed /tmp is the wrong place for them.
   */
  tempRoot?: string;
  /**
   * `--platform` for every build (`RYPH_ENV_BUILD_PLATFORM`, e.g. `linux/amd64`). Unset is the
   * daemon's own. It matters when the base images are another architecture than this machine:
   * the docker driver only takes a local image for a `FROM` of the build's own platform, and
   * otherwise goes to the registry for it.
   */
  platform?: string;
  /** Confine every build as the deployment confines its runs; see the header. */
  confine?: ConfinedBuilds;
  /**
   * The deployment id (the provisioner's `deploymentId`: its docker network, "default" unset)
   * whose repository path every tag goes under (`localImagePrefix`), and the only one whose local
   * images a build reads or a removal untags. Default: the confined runs' deployment, else
   * "default".
   */
  deployment?: string;
  /**
   * Why branch builds are refused: runs are sandboxed in a way this builder cannot follow.
   * Default-branch builds still build.
   */
  refuseBranchBuilds?: string;
  /**
   * Whether `refuseBranchBuilds` lets a build through on its spec's `defaultBranch`, a caller's
   * word. False: every build is refused where branch builds are. See the header.
   */
  trustDefaultBranch?: boolean;
  /**
   * Why an unconfined build (no `confine`) is refused: it would tag the universal image's public
   * names on a daemon other deployments build on (see the header). Unset: unconfined builds go,
   * as they do for the binary, the daemon's one tenant.
   */
  refuseUnconfined?: string;
}

export interface ConfinedBuilds {
  /** The run provisioner's options, with `runNetwork` and `gate` set: what a confined run gets. */
  docker: DockerOptions;
  /** The rootful BuildKit image a build's own builder runs (RYPH_ENV_BUILDKIT_IMAGE). */
  buildkitImage: string;
}

export interface DockerBuilderDeps {
  run?: CommandRunner;
  /** Makes the run network and the gate what `confine.docker` asks for; injected for tests. */
  ensureGate?: (opts: DockerOptions) => Promise<GateReady>;
}

/**
 * The repository path of the deployment whose docker network is unset (`deploymentId`'s
 * "default"): what the tags below default to, so a test or a single-deployment caller need not
 * spell it. The builder itself always passes its own (`DockerBuilderOptions.deployment`).
 */
const DEFAULT_PREFIX = localImagePrefix(deploymentId({}));

/**
 * The tag of a finished environment, which keeps it out of `docker image prune`'s reach. Under
 * `prefix`, the deployment's own repository path (`localImagePrefix`): the subject key and the
 * environment id are the caller's word, and a shared daemon's store is every deployment's, so
 * the deployment's digest is what keeps one deployment's tags from landing on another's.
 */
export function environmentTag(
  spec: Pick<BuildSpec, "subjectKey" | "environmentId">,
  prefix: string = DEFAULT_PREFIX,
): string {
  return `${prefix}${spec.subjectKey}:${safeName(spec.environmentId, 100)}`;
}

/**
 * The tag of a finished environment's baked stage — the image a re-layer builds FROM and a check
 * runs in. Kept as long as the environment's own, and removed with it by retention
 * (`removeImages`): it is the environment's lower layers under a second name, not a copy.
 */
export function bakedTag(
  spec: Pick<BuildSpec, "subjectKey" | "environmentId">,
  prefix: string = DEFAULT_PREFIX,
): string {
  return `${prefix}${spec.subjectKey}:baked-${safeName(spec.environmentId, 90)}`;
}

/** The machine's tag while a build runs; removed when it ends. */
export function machineTag(
  spec: Pick<BuildSpec, "subjectKey" | "environmentId">,
  prefix: string = DEFAULT_PREFIX,
): string {
  return `${prefix}${spec.subjectKey}:machine-${safeName(spec.environmentId, 90)}`;
}

/** How long one `removeImages` may take: a few untags, which the daemon answers in seconds. */
const REMOVE_TIMEOUT_MS = 120_000;
/** How long past the build timeout a retired cache version is kept for builds still reading it. */
const CACHE_GRACE_MS = 10 * 60 * 1000;

/**
 * One stage of one scope's cache, as a directory under the cache root: a version per build that
 * exported it, and CURRENT_FILE naming the version to read.
 *
 * Versions, because BuildKit's local exporter only ever adds blobs to the directory it writes:
 * exporting over the last export kept every layer any earlier build had written (measured: 2.2 of
 * 3.5 GB unreachable from the index after a day of builds of one repo). And never replaced in
 * place, because an import reads blobs lazily, for as long as the build runs: a version stops
 * being current when a newer one is promoted, and is deleted only once no build that could have
 * read it can still be running (`pruneCacheVersions`).
 */
export function scopeDir(cacheDir: string, scope: string, stage: string): string {
  return `${cacheDir}/${safeName(scope, 100)}/${stage}`;
}

const CURRENT_FILE = "current";

/** The version a build exports one stage's cache to: its own. */
export function cacheVersionDir(stageDir: string, environmentId: string): string {
  return `${stageDir}/v-${safeName(environmentId, 60)}`;
}

/** The version a build should import, or null when the stage has none yet. */
export async function currentCacheVersion(stageDir: string): Promise<string | null> {
  const name = (await readFile(`${stageDir}/${CURRENT_FILE}`, "utf8").catch(() => "")).trim();
  return /^v-[a-z0-9-]+$/.test(name) ? `${stageDir}/${name}` : null;
}

const modifiedMs = (path: string) => stat(path).then((s) => s.mtime.getTime(), () => null);

/**
 * Makes a finished export the stage's current version: the pointer is replaced by a rename, so a
 * reader finds the old version or the new one and never half of either. Two builds promoting at
 * once both land; the later one is current, and the other is pruned like any retired version.
 */
export async function promoteCache(
  stageDir: string,
  version: string,
  graceMs: number,
): Promise<boolean> {
  if (await modifiedMs(`${version}/index.json`) === null) return false;
  await trimCacheVersion(version);
  const previous = await currentCacheVersion(stageDir);
  const name = version.slice(stageDir.length + 1);
  const pointer = `${stageDir}/${CURRENT_FILE}.${name}`;
  // Marked before it stops being current, never after: a prune in between would otherwise age
  // it by when its build started, and delete what builds that resolved it still read.
  if (previous !== null && previous !== version) {
    await writeFile(`${previous}.retired`, "");
  }
  await writeFile(pointer, name);
  await rename(pointer, `${stageDir}/${CURRENT_FILE}`);
  // Another promotion's loop may have marked it while it was only a finished export: current
  // now, it is aged from when it next stops being current, not from then.
  if (await currentCacheVersion(stageDir) === version) {
    await rm(`${version}.retired`).catch(() => {});
  }
  // A promotion beside this one may have made its version current in between, and this rename
  // displaced it unmarked: every finished version that is not current waits out the grace too.
  for (const entry of await readdir(stageDir, { withFileTypes: true })) {
    const path = `${stageDir}/${entry.name}`;
    if (!entry.isDirectory() || !entry.name.startsWith("v-") || path === version) continue;
    if (await modifiedMs(`${path}.retired`) !== null) continue;
    if (await modifiedMs(`${path}/index.json`) !== null) {
      await writeFile(`${path}.retired`, "");
    }
  }
  await pruneCacheVersions(stageDir, graceMs);
  return true;
}

/**
 * Starts a version as hard links to the current one's blobs, so the export writes only what is
 * new — BuildKit skips a blob its content store already holds — and versions share what they
 * have in common on disk instead of each being a whole copy.
 */
export async function seedCacheVersion(stageDir: string, version: string): Promise<void> {
  const current = await currentCacheVersion(stageDir);
  if (current === null) return;
  const from = `${current}/blobs/sha256`;
  const to = `${version}/blobs/sha256`;
  await mkdir(to, { recursive: true });
  for (const blob of await readdir(from, { withFileTypes: true })) {
    if (blob.isFile()) await link(`${from}/${blob.name}`, `${to}/${blob.name}`).catch(() => {});
  }
}

/** Below this, a blob is read for the digests it names: manifests and the cache config are a few
 * KiB, and a layer that small names nothing (a false match only keeps a blob). */
const DESCRIPTOR_MAX_BYTES = 1024 * 1024;

/**
 * Deletes the blobs a finished export's index does not reach: the seeded links of layers no build
 * wants any more. What it reaches is followed through every small blob — manifests and BuildKit's
 * cache config, which name the layers — so a layer is kept whenever anything names it.
 */
export async function trimCacheVersion(version: string): Promise<void> {
  const blobs = `${version}/blobs/sha256`;
  const reached = new Set<string>();
  const queue = [{ text: await readFile(`${version}/index.json`, "utf8"), root: true }];
  while (queue.length > 0) {
    const { text, root } = queue.pop()!;
    for (const [, hex] of text.matchAll(/sha256:([0-9a-f]{64})/g)) {
      if (reached.has(hex)) continue;
      reached.add(hex);
      const size = await stat(`${blobs}/${hex}`).then((s) => s.size, () => null);
      // What the index names is a manifest, whatever its size: past it, nothing would be reached.
      if (size !== null && (root || size <= DESCRIPTOR_MAX_BYTES)) {
        queue.push({
          text: new TextDecoder().decode(await readFile(`${blobs}/${hex}`)),
          root: false,
        });
      }
    }
  }
  for (const blob of await readdir(blobs, { withFileTypes: true }).catch(() => [])) {
    if (!reached.has(blob.name)) await rm(`${blobs}/${blob.name}`).catch(() => {});
  }
}

/** `pruneCacheVersions` over every stage of every scope: a scope nobody builds any more is pruned
 * too, by whichever build comes next. */
export async function pruneCacheRoot(cacheDir: string, graceMs: number): Promise<void> {
  for (const scope of await readdir(cacheDir, { withFileTypes: true }).catch(() => [])) {
    if (!scope.isDirectory()) continue;
    for (const stage of ["machine", "environment"]) {
      await pruneCacheVersions(`${cacheDir}/${scope.name}/${stage}`, graceMs);
    }
  }
}

/**
 * Deletes what no build can be reading: a version retired more than `graceMs` ago, or one never
 * promoted whose directory last changed that long ago (made when its build started; blob writes
 * below it leave its mtime alone, the export's own files at the top bump it). `graceMs` must
 * outlast a build, so every build that resolved or is writing it has ended. A crashed build's
 * export goes the same way, and so does anything else in the stage (the layout before versions).
 */
export async function pruneCacheVersions(stageDir: string, graceMs: number) {
  const current = await currentCacheVersion(stageDir);
  const cutoff = Date.now() - graceMs;
  const entries = await readdir(stageDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = `${stageDir}/${entry.name}`;
    let stale = false;
    if (path === current || entry.name === CURRENT_FILE) continue;
    if (entry.isDirectory() && entry.name.startsWith("v-")) {
      const at = await modifiedMs(`${path}.retired`) ?? await modifiedMs(path);
      stale = at !== null && at < cutoff;
      if (stale) await rm(`${path}.retired`).catch(() => {});
    } else if (entry.name.endsWith(".retired") && entry.isFile()) {
      // A marker whose version is gone.
      stale = await modifiedMs(path.slice(0, -".retired".length)) === null;
    } else if (entry.name.startsWith(`${CURRENT_FILE}.`)) {
      // A pointer a crashed promotion left half done.
      const at = await modifiedMs(path);
      stale = at !== null && at < cutoff;
    } else {
      // Nothing a version is made of: what the stage held before versions.
      stale = true;
    }
    if (stale) await rm(path, { recursive: true }).catch(() => {});
  }
}

/** The directories a build works in, all under one temp dir. */
export interface Workdirs {
  root: string;
  checkout: string;
  outer: string;
  toolchains: string;
  /** Where an incremental build's machine record is read out to. */
  record: string;
  iidfile: string;
  /** A confined build's input images, one OCI layout each, and the machine it builds. */
  layouts: string;
}

export function workdirs(root: string): Workdirs {
  return {
    root,
    checkout: `${root}/checkout`,
    outer: `${root}/outer`,
    toolchains: `${root}/toolchains`,
    record: `${root}/record`,
    iidfile: `${root}/image.id`,
    layouts: `${root}/layouts`,
  };
}

/**
 * The images a confined build starts from, by the names its passes are handed them under: each
 * is a named context (an OCI layout), and the outer file's build arguments name these instead of
 * images the builder could not read.
 */
export const CONFINED_INPUTS = {
  base: "ryph-input/base",
  harness: "ryph-input/harness",
  machine: "ryph-input/machine",
  warm: "ryph-input/warm",
  baked: "ryph-input/baked",
} as const;
export type ConfinedInput = keyof typeof CONFINED_INPUTS;

/** What a confined build's argv needs beyond the spec. */
export interface ConfinedPass {
  /** The build's own builder (`confinedBuilderName`). */
  builder: string;
  /** Each input exported so far, as an `oci-layout://` reference. */
  layouts: Partial<Record<ConfinedInput, string>>;
  /** The proxy variables as a RUN step on the build's network dials them (`confinedProxyEnv`). */
  proxyEnv: Record<string, string>;
}

/**
 * A confined build's builder: one per environment, so `discard` can find an orphaned one. Its
 * network has the same name. The deployment's in it, as a fixed-length digest so no environment
 * id can spell another deployment's: buildx labels nothing it makes, and its docker-container
 * driver STARTS an existing `buildx_buildkit_<name>0` rather than make one, mounting whatever
 * `…_state` volume holds the name. The environment id is the caller's word, so on a shared daemon
 * a bare one could hand this build another deployment's BuildKit and cache.
 */
export function confinedBuilderName(environmentId: string, docker: DockerOptions): string {
  return `${confinedBuilderPrefix(docker)}${safeName(environmentId, 40)}`;
}

/** What every confined builder (and build network) of this deployment's name starts with: a
 * teardown finds a launcher's leftover BuildKit containers and state volumes by it. */
export function confinedBuilderPrefix(docker: Pick<DockerOptions, "network">): string {
  return confinedBuilderPrefixFor(deploymentId(docker));
}

/**
 * Takes a confined build's builder away: through buildx, which knows the builders under this
 * process's HOME, then its BuildKit container and state volume by name, which a buildx that lost
 * its HOME (a restarted launcher) no longer knows and would otherwise start again. The name is
 * this deployment's (`confinedBuilderName`), so what holds it is this deployment's. Best effort.
 */
async function removeBuilder(run: CommandRunner, name: string, signal: () => AbortSignal) {
  await run("docker", ["buildx", "rm", "--force", name], { signal: signal() }).catch(() => {});
  await run("docker", ["rm", "-f", `buildx_buildkit_${name}0`], { signal: signal() })
    .catch(() => {});
  await run("docker", ["volume", "rm", "-f", `buildx_buildkit_${name}0_state`], {
    signal: signal(),
  }).catch(() => {});
}

/** The label on a confined build's network: the environment it was made for. */
export const BUILD_NETWORK_LABEL = "ryph.build";

/**
 * Takes a confined build's network away — the gate off it, then the network — found by its labels,
 * the environment's and this deployment's, and never by its name: the name is the environment id's,
 * which the caller chose, and another deployment on the same daemon may hold a network by it.
 * Best effort, as every cleanup here is.
 */
async function removeBuildNetworks(
  run: CommandRunner,
  environmentId: string,
  docker: DockerOptions,
  signal: () => AbortSignal,
): Promise<void> {
  const listed = await run("docker", [
    "network",
    "ls",
    "-q",
    "--filter",
    `label=${BUILD_NETWORK_LABEL}=${environmentId}`,
    "--filter",
    `label=${DEPLOYMENT_LABEL}=${deploymentId(docker)}`,
  ], { signal: signal() }).catch(() => null);
  if (listed === null || listed.code !== 0) return;
  const gate = gateName(docker);
  for (const id of listed.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "")) {
    await run("docker", ["network", "disconnect", "--force", id, gate], { signal: signal() })
      .catch(() => {});
    await run("docker", ["network", "rm", id], { signal: signal() }).catch(() => {});
  }
}

/** An OCI layout directory as a named context, pinned to the image it holds. The tag is only
 * there because buildx misparses a digest without one (measured, buildx 0.33). */
export function layoutRef(dir: string, digest: string): string {
  return `oci-layout://${dir}:ryph@${digest}`;
}

/** Where a confined build writes its machine, as an OCI layout. */
export function machineLayout(dirs: Workdirs): string {
  return `${dirs.layouts}/machine`;
}

/** Docker's name for the host, which an unconfined build's proxy may be served at. */
const HOST_ALIAS = "host.docker.internal";

/**
 * The proxy variables with the gate's name replaced by its address on the build's network, which is
 * the one form a RUN step can dial: it resolves nothing (see the header). A proxy named anything
 * else is left as it is, for `proxyOffGate` to refuse before any builder is made: it would be
 * unreachable from the build's network, and fail the build's first fetch with no reason given.
 */
export function confinedProxyEnv(
  proxyEnv: Record<string, string>,
  gate: string,
  gateAddress: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(proxyEnv).map(([key, value]) => {
      const url = URL.parse(value);
      if (url === null || url.hostname !== gate) return [key, value];
      url.hostname = gateAddress;
      return [key, url.href.replace(/\/$/, "")];
    }),
  );
}

/**
 * The first proxy a confined build is handed that is not the run gate at `gateAddress` — after
 * `confinedProxyEnv` — without its credentials, or null when every one is the gate. Such a proxy
 * cannot be reached from the build's network, so the build is refused rather than left to time out.
 */
export function proxyOffGate(
  proxyEnv: Record<string, string>,
  gateAddress: string,
): string | null {
  for (const [key, value] of proxyBuildArgs(proxyEnv)) {
    if (key.toUpperCase() === "NO_PROXY") continue;
    const url = URL.parse(value);
    if (url !== null && url.hostname === gateAddress) continue;
    if (url === null) return "a proxy URL that does not parse";
    url.username = "";
    url.password = "";
    return url.href.replace(/\/$/, "");
  }
  return null;
}

/**
 * The `docker buildx create` argv for a confined build's builder: on its own network alone, with
 * the build's claim as BuildKit's own proxy, for the images a `.ryph/Dockerfile` pulls. A value
 * buildx would split (its options are comma-separated) is refused rather than mangled.
 */
export function confinedBuilderArgs(
  name: string,
  network: string,
  confine: ConfinedBuilds,
  proxyEnv: Record<string, string>,
): string[] {
  const args = [
    "buildx",
    "create",
    "--name",
    name,
    "--driver",
    "docker-container",
    "--driver-opt",
    `network=${network}`,
    "--driver-opt",
    `image=${confine.buildkitImage}`,
  ];
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY"]) {
    const value = proxyEnv[key];
    if (value === undefined) continue;
    if (/[,"]/.test(value)) throw new Error(`the build's ${key} has a character buildx splits on`);
    args.push("--driver-opt", `env.${key}=${value}`);
  }
  args.push("--bootstrap");
  return args;
}

/** Whether a proxy build argument names the host by docker's alias for it, which a build step
 * resolves only when it is handed the mapping (a native Linux daemon has no such name). */
function proxyOnHostAlias(proxyEnv: Record<string, string>): boolean {
  return proxyBuildArgs(proxyEnv).some(([, value]) => URL.parse(value)?.hostname === HOST_ALIAS);
}

/** The pieces every pass's argv is made of; see `buildArgvs`. */
function argvParts(
  spec: BuildSpec,
  /** `read`: each read scope's current version per stage (`${scope}/${stage}`); a scope with
   * none is not read. */
  cache: { dir: string; read: ReadonlyMap<string, string> } | null,
  platform: string | undefined,
  warm: boolean,
  confined: ConfinedPass | null,
) {
  const relayer = spec.relayerFrom !== null;
  /** An input image as a pass names it: itself, or — confined — the context it was handed as. */
  const image = (input: ConfinedInput, ref: string) =>
    confined === null ? ref : CONFINED_INPUTS[input];
  /** The named contexts that hand a confined pass its inputs; nothing unconfined. */
  const layout = (name: ConfinedInput): string => {
    const ref = confined?.layouts[name];
    if (ref === undefined) throw new Error(`confined build: ${name} was not exported`);
    return ref;
  };
  const inputs = (...names: ConfinedInput[]): string[] =>
    confined === null
      ? []
      : names.flatMap((name) => ["--build-context", `${CONFINED_INPUTS[name]}=${layout(name)}`]);
  const proxyEnv = confined?.proxyEnv ?? spec.proxyEnv;
  const head = (): string[] => [
    "buildx",
    "build",
    // Confined, no attestation either: whether buildx adds one by default depends on its version
    // and env, and one in the machine's layout would make its digest new on every build.
    ...(confined === null ? [] : ["--builder", confined.builder, "--provenance=false"]),
    "--progress",
    "plain",
    ...(platform ? ["--platform", platform] : []),
  ];
  const common = (stage: string, exportCache = true): string[] => {
    const args = head();
    // The name a run uses for the host (docker provisioner), when the proxy the build is handed
    // is served there: a native Linux daemon resolves it only with the mapping. Nothing else in a
    // build needs the host, so a build whose proxy is elsewhere, or that has none, is not given
    // a name for it — and a confined one never is: it reaches the proxy through the gate.
    if (confined === null && proxyOnHostAlias(proxyEnv)) {
      args.push("--add-host", `${HOST_ALIAS}:host-gateway`);
    }
    for (const [key, value] of proxyBuildArgs(proxyEnv)) {
      args.push("--build-arg", `${key}=${value}`);
    }
    // A re-layer and a warm pass start FROM an image they name: nothing below it to find in a
    // cache, and nothing a cold build would want written to one. The machine is built from the
    // cache on every build, since that is what makes an unchanged one the same image.
    if (cache !== null && !relayer && (!warm || stage === "machine")) {
      for (const scope of spec.cacheScope.read) {
        const version = cache.read.get(`${scope}/${stage}`);
        if (version !== undefined) args.push("--cache-from", `type=local,src=${version}`);
      }
      if (exportCache && spec.cacheScope.write !== null) {
        const dest = cacheVersionDir(
          scopeDir(cache.dir, spec.cacheScope.write, stage),
          spec.environmentId,
        );
        args.push("--cache-to", `type=local,dest=${dest},mode=max`);
      }
    }
    return args;
  };
  return { image, layout, inputs, head, common };
}

/**
 * The argv of the two builds that come before the outer passes, which must know their answers:
 * the machine, and an incremental build's check of which machine its image was built on.
 */
export function machineArgvs(
  spec: BuildSpec,
  dirs: Workdirs,
  cache: { dir: string; read: ReadonlyMap<string, string> } | null,
  platform?: string,
  confined: ConfinedPass | null = null,
  /** The deployment's repository path (`localImagePrefix`) the machine is tagged under. */
  prefix: string = DEFAULT_PREFIX,
): { machine: string[] | null; record: string[] | null } {
  const relayer = spec.relayerFrom !== null;
  const { image, layout, inputs, head, common } = argvParts(
    spec,
    cache,
    platform,
    false,
    confined,
  );
  const machine = spec.dockerfileFrom === null || relayer ? null : [
    ...common("machine"),
    "-f",
    `${dirs.checkout}/${spec.dockerfileFrom}/.ryph/Dockerfile`,
    // Confined, the universal image's public names are contexts, not tags in a store the builder
    // cannot read; and the machine is written out as a layout for the outer passes to take.
    ...(confined === null ? [] : UNIVERSAL_IMAGE_REFS.flatMap((ref) => [
      "--build-context",
      `${ref}=${layout("base")}`,
    ])),
    ...(confined === null
      ? ["--tag", machineTag(spec, prefix), "--load"]
      : ["--output", `type=oci,dest=${machineLayout(dirs)},tar=false`]),
    `${dirs.checkout}/${spec.dockerfileFrom}`,
  ];

  const record = relayer || spec.warmFrom === null ? null : [
    ...head(),
    "-f",
    `${dirs.outer}/${WARM_FILE}`,
    "--target",
    MACHINE_RECORD_TARGET,
    "--build-arg",
    `RYPH_WARM=${image("warm", spec.warmFrom)}`,
    ...inputs("warm"),
    // Unused by this target, but the frontend resolves every stage's FROM (measured, buildx
    // 0.33: "base name (${RYPH_HARNESS}) should not be blank").
    "--build-arg",
    `RYPH_HARNESS=${image("harness", spec.harnessImage)}`,
    ...inputs("harness"),
    "--output",
    `type=local,dest=${dirs.record}`,
    dirs.outer,
  ];

  return { machine, record };
}

/**
 * The argv of every build this adapter runs, in order. Pure, and exported for the test: this is
 * the whole contract between the control plane and BuildKit on this backend. A confined build's
 * outer passes need the machine's layout, so the build runs `machineArgvs` first.
 */
export function buildArgvs(
  spec: BuildSpec,
  dirs: Workdirs,
  /** `read`: each read scope's current version per stage (`${scope}/${stage}`); a scope with
   * none is not read. */
  cache: { dir: string; read: ReadonlyMap<string, string> } | null,
  platform?: string,
  /**
   * How the outer passes run: incrementally only when the machine check passed (see `build`),
   * and with the machine's id recorded in the image either way.
   */
  pass: { warm: boolean; machineDigest: string } = {
    warm: spec.warmFrom !== null,
    machineDigest: "",
  },
  /** Set, every pass runs on the build's own confined builder; see the header. */
  confined: ConfinedPass | null = null,
  /** The deployment's repository path (`localImagePrefix`) every tag goes under. */
  prefix: string = DEFAULT_PREFIX,
): {
  machine: string[] | null;
  /** An incremental build's check of which machine its image was built on. */
  record: string[] | null;
  environment: string[];
  baked: string[] | null;
  toolchains: string[];
} {
  const relayer = spec.relayerFrom !== null;
  const warm = !relayer && pass.warm;
  const { machine, record } = machineArgvs(spec, dirs, cache, platform, confined, prefix);
  const { image, inputs, common } = argvParts(spec, cache, platform, warm, confined);

  const outer = (target: string, exportCache: boolean): string[] => [
    ...common("environment", exportCache),
    "-f",
    `${dirs.outer}/${warm ? WARM_FILE : "Dockerfile"}`,
    "--target",
    target,
    ...(relayer
      ? ["--build-arg", `RYPH_BAKED=${image("baked", spec.relayerFrom!)}`, ...inputs("baked")]
      : warm
      ? ["--build-arg", `RYPH_WARM=${image("warm", spec.warmFrom!)}`, ...inputs("warm")]
      : [
        "--build-arg",
        `RYPH_MACHINE=${
          machine === null
            ? image("base", spec.baseImage)
            : image("machine", machineTag(spec, prefix))
        }`,
        ...inputs(machine === null ? "base" : "machine"),
        "--build-arg",
        `RYPH_MACHINE_DIGEST=${pass.machineDigest}`,
      ]),
    "--build-arg",
    `RYPH_HARNESS=${image("harness", spec.harnessImage)}`,
    ...inputs("harness"),
    ...(relayer ? [] : ["--build-context", `checkout=${dirs.checkout}`]),
  ];

  return {
    machine,
    record,
    environment: [
      ...outer(ENVIRONMENT_TARGET, true),
      "--tag",
      environmentTag(spec, prefix),
      // The id a `--load` from another builder reports is not always the store's (the classic
      // store names an image by its config), so a confined build asks the store for it instead.
      ...(confined === null ? ["--iidfile", dirs.iidfile] : []),
      "--load",
      dirs.outer,
    ],
    // No cache export on the two that follow: they are all hits, and writing the scope again
    // would only race the environment build's own export.
    baked: relayer ? null : [
      ...outer(BAKED_TARGET, false),
      "--tag",
      bakedTag(spec, prefix),
      "--load",
      dirs.outer,
    ],
    // No cache export on this one: it is all hits, and writing the scope again would only race
    // the environment build's own export.
    toolchains: [
      ...outer(TOOLCHAINS_TARGET, false),
      "--output",
      `type=local,dest=${dirs.toolchains}`,
      dirs.outer,
    ],
  };
}

/** An argv as a log line, with the value of every proxy build argument — the egress claim — hidden,
 * and of every variable a confined build's BuildKit is started with, which is the same claim. */
export function redactedCommand(cmd: string, args: string[]): string {
  const shown = args.map((arg, i) => {
    if (args[i - 1] === "--driver-opt" && arg.startsWith("env.")) {
      return `${arg.slice(0, Math.max(arg.indexOf("="), 0))}=***`;
    }
    if (args[i - 1] !== "--build-arg") return arg;
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    return key.startsWith("RYPH_") ? arg : `${key}=***`;
  });
  return `$ ${cmd} ${shown.join(" ")}`;
}

/** Why a build stopped early: the port's failure kinds, plus a cancel. */
type Stop = "timeout" | "cancelled";

class BuildStep extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function dockerEnvironmentBuilder(
  opts: DockerBuilderOptions,
  diag: Diagnostics,
  deps: DockerBuilderDeps = {},
): EnvironmentBuilder {
  const run = deps.run ?? runCommand;
  const prefix = localImagePrefix(opts.deployment ?? deploymentId(opts.confine?.docker ?? {}));
  let cacheSupported: boolean | null = null;
  /** The log of each build this process is running. A build here dies with its process, so this
   * map is the whole of what there is to show, and only this process can show it. */
  const running = new Map<string, BuildLog>();
  let narratedCache = false;

  /** Whether this daemon can export a BuildKit cache: only with the containerd image store. */
  async function canExportCache(signal: AbortSignal): Promise<boolean> {
    if (cacheSupported !== null) return cacheSupported;
    const info = await run("docker", ["info", "--format", "{{json .DriverStatus}}"], { signal });
    cacheSupported = info.code === 0 && info.stdout.includes("io.containerd.snapshotter");
    return cacheSupported;
  }

  return {
    kind: "docker",

    /**
     * Nothing to adopt, ever, and the honest answer is to say so at once.
     *
     * A build here is a `docker buildx build` child of this process writing into a temporary
     * directory this process made. When the control plane goes, the buildx client goes with it
     * and the daemon drops the solve; what is left is a temp directory with no iidfile in it,
     * belonging to a process id that means nothing any more. `gone` is therefore not a shrug: it
     * is the fact, and it lets the core fail the row inside a tick instead of leaving a queue slot
     * held by a build that died with its parent.
     *
     * What the dead build may have tagged before it died — the environment, its baked stage — is
     * untagged on the way: the row it was for fails now, so nothing would ever record or retire
     * those images. Not the baked image a re-layer was given: that is its source's.
     */
    async adopt(spec): Promise<AdoptResult> {
      const tags = [
        environmentTag(spec, prefix),
        ...(spec.relayerFrom === null ? [bakedTag(spec, prefix)] : []),
      ];
      for (const tag of tags) {
        await run("docker", ["image", "rm", tag], {
          signal: AbortSignal.timeout(REMOVE_TIMEOUT_MS),
        })
          .catch(() => {});
      }
      return { kind: "gone" };
    },

    /** What the running build has logged so far. Each command's output lands when the command
     * ends (it is read whole), so a long `docker buildx build` shows up in one piece. */
    liveLog(spec): Promise<string | null> {
      return Promise.resolve(running.get(spec.environmentId)?.text() ?? null);
    },

    /**
     * Nothing to discard unconfined, for the same reason: what a build leaves here is a temp
     * directory the build itself removes, and a solve the daemon dropped when its client went.
     * Confined, a build's builder is a container on a network of its own, which a control plane
     * that died mid-build leaves behind — so both go here, by the name the environment gives them.
     */
    async discard(environmentId): Promise<void> {
      if (opts.confine === undefined) return;
      const name = confinedBuilderName(environmentId, opts.confine.docker);
      const signal = AbortSignal.timeout(REMOVE_TIMEOUT_MS);
      await removeBuilder(run, name, () => signal);
      await removeBuildNetworks(run, environmentId, opts.confine.docker, () => signal);
    },

    /**
     * Untags the environment and, when the core passes it, the baked stage, so the daemon deletes
     * whatever layers no other image holds. Never forced: an image a container still uses — a
     * run's or a check's, even a stopped one — is a `conflict`, and stays for a later sweep. A
     * build no row recorded (`recorded` false) has its own baked tag untagged too: a failed build
     * untags what it tagged itself, so that is a no-op unless the process died between the two.
     * Here a tag IS the image, so going by the names is going by what was built.
     */
    async removeImages(spec: RemoveImagesSpec): Promise<boolean> {
      const signal = AbortSignal.timeout(REMOVE_TIMEOUT_MS);
      const names = [environmentTag(spec, prefix)];
      // Only a name this adapter gave out, under this deployment's repository: a re-layer's baked
      // image is always one of its tags, and the caller's word must not untag another's.
      if (spec.bakedImage?.startsWith(prefix)) names.push(spec.bakedImage);
      const baked = bakedTag(spec, prefix);
      if (!spec.recorded && !names.includes(baked)) names.push(baked);
      let kept = false;
      for (const name of names) {
        const result = await run("docker", ["image", "rm", name], { signal });
        if (result.code === 0 || /no such image/i.test(result.stderr)) continue;
        if (/conflict/i.test(result.stderr)) {
          // The baked stage is what the kept image is built on: it stays with it.
          kept = true;
          break;
        }
        throw new Error(
          `docker image rm ${name}: ${result.stderr.trim() || `exit ${result.code}`}`,
        );
      }
      return !kept;
    },

    async build(requested: BuildSpec, { signal }): Promise<BuildResult> {
      assertBuildable(requested);
      let spec = requested;
      if (opts.confine === undefined && opts.refuseUnconfined !== undefined) {
        const message = `builds are refused on this deployment: ${opts.refuseUnconfined}`;
        return { ok: false, kind: "failed", message, logTail: message, log: `ryph: ${message}\n` };
      }
      // A re-layer is refused too: its harness layer RUNs a check in the image it builds on, with
      // that image's own shell and libraries — which a branch build put there.
      if (
        opts.refuseBranchBuilds !== undefined &&
        !(opts.trustDefaultBranch === true && spec.defaultBranch)
      ) {
        const message = opts.trustDefaultBranch === true
          ? `branch builds are refused on this deployment: ${opts.refuseBranchBuilds}`
          : `builds are refused on this deployment: ${opts.refuseBranchBuilds}, and the docker ` +
            "launcher does not take a caller's word that a build is of the default branch " +
            "(RYPH_ENV_TRUST_DEFAULT_BRANCH=on on the launcher would)";
        return { ok: false, kind: "failed", message, logTail: message, log: `ryph: ${message}\n` };
      }
      const log = new BuildLog();
      const stop = new AbortController();
      let stopped: Stop | null = null;
      const onAbort = () => {
        stopped ??= "cancelled";
        stop.abort();
      };
      if (signal.aborted) onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        stopped ??= "timeout";
        stop.abort();
      }, spec.timeoutMs);

      /** Runs one command into the log; a non-zero exit is the step failing, named. */
      const step = async (
        what: string,
        cmd: string,
        args: string[],
        extra: { cwd?: string; env?: Record<string, string> } = {},
      ): Promise<CommandResult> => {
        if (stop.signal.aborted) throw new BuildStep(what);
        log.append(redactedCommand(cmd, args));
        let result: CommandResult;
        try {
          result = await run(cmd, args, { ...extra, signal: stop.signal });
        } catch (err) {
          if (stop.signal.aborted) throw new BuildStep(what);
          throw new BuildStep(`${what}: ${err instanceof Error ? err.message : err}`);
        }
        log.append(result.stdout);
        log.append(result.stderr);
        if (result.code !== 0) {
          const why = failureLine(`${result.stdout}\n${result.stderr}`);
          throw new BuildStep(why === null ? what : `${what}: ${why}`);
        }
        return result;
      };

      const inStore = async (image: string) =>
        (await run("docker", ["image", "inspect", image], { signal: stop.signal })).code === 0;
      /** An image in the local store, pulled first when it is not there yet. Only for the base
       * and the harness, which have a registry to come from. */
      const present = async (image: string, what: string) => {
        if (!await inStore(image)) await step(`pulling ${what} failed`, "docker", ["pull", image]);
      };
      /** The run gate and its address on the build's network, once a confined build has found them. */
      let gateAt: { gate: string; address: string; network: string } | null = null;
      /** The gate's address now — null when it has none, undefined when docker could not say:
       * a confined build checks it to tell a gate replaced under it from any other failure. */
      const gateAddressNow = async (gate: string, network: string) => {
        const inspected = await run(
          "docker",
          ["inspect", "-f", "{{json .NetworkSettings.Networks}}", gate],
          { signal: AbortSignal.timeout(10_000) },
        ).catch(() => null);
        return inspected?.code === 0 ? gateAddress(inspected.stdout, network) : undefined;
      };

      if (opts.tempRoot !== undefined) await mkdir(opts.tempRoot, { recursive: true });
      const root = await mkdtemp(join(opts.tempRoot ?? tmpdir(), "ryph-env-"));
      const dirs = workdirs(root);
      let machineBuilt = false;
      let builder: string | null = null;
      let buildNetwork: { network: string; gate: string } | null = null;
      /** What this build tagged, and whether it ended up an image a row will record. */
      const tagged: string[] = [];
      let succeeded = false;
      /** The stage directories this build exports to, when it writes a cache at all. */
      let exports: { machine: string; environment: string } | null = null;
      const promoted = new Set<"machine" | "environment">();
      const version = (stage: "machine" | "environment") =>
        cacheVersionDir(exports![stage], spec.environmentId);
      // Best effort: a cache that could not be promoted costs the next build its hits, never this
      // build its image.
      const promote = async (stage: "machine" | "environment") => {
        try {
          if (
            await promoteCache(exports![stage], version(stage), spec.timeoutMs + CACHE_GRACE_MS)
          ) promoted.add(stage);
        } catch (err) {
          diag.warn("environment_builder.docker.cache_promote_failed", {
            dir: exports![stage],
            err: String(err),
          });
        }
      };
      running.set(spec.environmentId, log);
      try {
        await mkdir(dirs.checkout);
        await mkdir(dirs.outer);
        log.say(`environment ${spec.environmentId} for ${spec.subjectKey}`);

        // The image a re-layer or a warm build starts from is one of this store's own, under a
        // name that is not a registry's: when it is gone, a pull would ask Docker Hub for it.
        // So it is never pulled. A re-layer has nothing else to build on; a warm build builds
        // cold instead, as it does when its image was built on another machine.
        // Every image the spec names is judged on the image docker resolves it to (`judgeImage`):
        // the names are the caller's word, docker resolves more spellings than a check of the name
        // can follow, and another deployment's environment on a shared daemon is not this build's
        // to read. A re-layer or warm image that is absent or not this deployment's is met as one
        // gone from the store, worded alike either way; a base or harness image that is any
        // environment image, this deployment's included, is refused, since the base is tagged
        // under the universal image's public names, where every deployment's build reads it.
        const dockerOut = async (args: string[]) => {
          const read = await run("docker", args, { signal: stop.signal });
          if (read.code !== 0) throw new Error(read.stderr || read.stdout);
          return read.stdout;
        };
        const ownRef = async (image: string) => {
          try {
            return await ownImageRef(image, prefix, dockerOut);
          } catch (err) {
            throw new BuildStep(err instanceof Error ? err.message : String(err));
          }
        };
        /** A base or harness image as the build may use it: no environment image's. */
        const inputRef = async (what: string, image: string) => {
          try {
            return await noEnvironmentImageRef(image, dockerOut);
          } catch (err) {
            throw new BuildStep(
              `the ${what} ${image} cannot be built on: ${
                err instanceof Error ? err.message : err
              }`,
            );
          }
        };
        await inputRef("base image", spec.baseImage);
        await inputRef("harness image", spec.harnessImage);
        if (spec.relayerFrom !== null && await ownRef(spec.relayerFrom) === null) {
          throw new BuildStep(
            `${notOwnImage(spec.relayerFrom)}; the re-layer has nothing to build on, and the ` +
              "environment needs a full build",
          );
        }
        if (
          spec.relayerFrom === null && spec.warmFrom !== null &&
          await ownRef(spec.warmFrom) === null
        ) {
          log.say(`${notOwnImage(spec.warmFrom)}; building from scratch`);
          spec = { ...spec, warmFrom: null };
        }

        if (spec.relayerFrom === null) {
          log.say(`cloning ${spec.checkouts.map((c) => c.path).join(", ")}`);
          await step("cloning the repositories failed", "bash", [
            "-c",
            cloneScript(),
            "clone",
            ...cloneArgs(spec),
          ], {
            cwd: dirs.checkout,
            // Git's env and nothing else's: the credential is for this one process. And none of
            // this machine's git configuration: a filter or hook named there (git-lfs's smudge,
            // a credential helper) would otherwise run on the host over repo-authored content.
            env: {
              ...spec.clone.env,
              GIT_TERMINAL_PROMPT: "0",
              GIT_LFS_SKIP_SMUDGE: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_ATTR_NOSYSTEM: "1",
            },
          });
        } else {
          log.say(`re-layering ${spec.relayerFrom} onto ${spec.harnessImage}`);
        }
        await writeFile(
          `${dirs.outer}/Dockerfile`,
          spec.relayerFrom !== null ? relayerDockerfile() : environmentDockerfile(),
        );
        // A warm build gets the full file too: it builds that one when its machine changed.
        if (spec.relayerFrom === null && spec.warmFrom !== null) {
          await writeFile(`${dirs.outer}/${WARM_FILE}`, warmDockerfile());
        }

        let confined: ConfinedPass | null = null;
        if (opts.confine !== undefined) {
          const confine = opts.confine;
          // The gate, as a confined launch makes it: the build's only way to the proxy.
          const ready = await (deps.ensureGate ?? ensureGate)(confine.docker).catch((err) => {
            throw new BuildStep(
              `the run gate is not ready: ${err instanceof Error ? err.message : err}`,
            );
          });
          for (const forced of ready.forced ?? []) {
            diag.warn("environment_builder.docker.gate_recreated_under_live_runs", {
              environmentId: spec.environmentId,
              ...gateForcedWarning(forced),
            });
          }
          if (ready.state === "deferred") {
            diag.warn("environment_builder.docker.gate_recreate_deferred", {
              environmentId: spec.environmentId,
              live: ready.live,
              detail: "the run gate no longer matches this deployment's configuration, but " +
                "confined containers are live behind it — it is remade once none are, or once " +
                "it has waited out the cap",
            });
          }
          // A network of the build's own, made as a run's services network is, with the gate on
          // it and nothing else. Not the run network: a RUN step is root with BuildKit's default
          // capabilities, raw sockets among them, where every run has dropped all of its own — on
          // a shared network it could answer for the gate's address to its neighbours.
          const gate = gateName(confine.docker);
          const network = confinedBuilderName(spec.environmentId, confine.docker);
          log.say(`confining the build to ${network}, with the run gate`);
          // Ones left by a control plane that died mid-build would make `create` fail: the
          // builder first, since a network with its container still on it cannot go.
          await removeBuilder(run, network, () => stop.signal);
          await removeBuildNetworks(run, spec.environmentId, confine.docker, () => stop.signal);
          buildNetwork = { network, gate };
          await step("making the build's network failed", "docker", [
            "network",
            "create",
            ...confinedNetworkFlags({ ...confine.docker, isolateGateway: ready.isolateGateway }),
            // What it is, should one ever outlive both its build and `discard`, and whose: the
            // teardown finds it by both.
            "--label",
            `${BUILD_NETWORK_LABEL}=${spec.environmentId}`,
            "--label",
            `${DEPLOYMENT_LABEL}=${deploymentId(confine.docker)}`,
            network,
          ]);
          await step("putting the run gate on the build's network failed", "docker", [
            "network",
            "connect",
            network,
            gate,
          ]);
          const address = gateAddress(
            (await step("finding the run gate failed", "docker", [
              "inspect",
              "-f",
              "{{json .NetworkSettings.Networks}}",
              gate,
            ])).stdout,
            network,
          );
          if (address === null) {
            throw new BuildStep(`the run gate ${gate} has no address on ${network}`);
          }
          gateAt = { gate, address, network };
          const proxyEnv = confinedProxyEnv(spec.proxyEnv, gate, address);
          const offGate = proxyOffGate(proxyEnv, address);
          if (offGate !== null) {
            throw new BuildStep(
              `the egress proxy ${offGate} is not the run gate ${gate}, the only proxy a ` +
                "confined build reaches",
            );
          }
          builder = network;
          let create: string[];
          try {
            create = confinedBuilderArgs(builder, network, confine, proxyEnv);
          } catch (err) {
            throw new BuildStep(err instanceof Error ? err.message : String(err));
          }
          await step("starting the build's own BuildKit failed", "docker", create);
          const handed: ConfinedPass = { builder, layouts: {}, proxyEnv };
          confined = handed;

          // Every image a pass starts from, out of the store and into a layout the builder reads.
          await mkdir(dirs.layouts);
          // Each is a full `docker image save`, so they run side by side.
          const inputs: Array<[ConfinedInput, string]> = [["harness", spec.harnessImage]];
          if (spec.relayerFrom !== null) inputs.push(["baked", spec.relayerFrom]);
          else inputs.push(["base", spec.baseImage]);
          if (spec.warmFrom !== null) inputs.push(["warm", spec.warmFrom]);
          const exported = await Promise.allSettled(inputs.map(async ([name, ref]) => {
            // The baked and warm images were checked above, and are never pulled. Each is saved
            // by the id it resolves to now, judged again, so what the build is handed is what was
            // judged.
            let image: string | null;
            if (name === "base" || name === "harness") {
              await present(ref, `the ${name} image`);
              image = await inputRef(`${name} image`, ref);
            } else {
              image = await ownRef(ref);
            }
            if (image === null) throw new BuildStep(notOwnImage(ref));
            const dir = `${dirs.layouts}/${name}`;
            await mkdir(dir);
            await step(`handing the build the ${name} image failed`, "bash", [
              "-c",
              'set -o pipefail; docker image save "${@:3}" "$1" | tar -x -C "$2"',
              "export",
              image,
              dir,
              ...(opts.platform ? ["--platform", opts.platform] : []),
            ]);
            const digest = await layoutDigest(dir);
            if (digest === null) {
              throw new BuildStep(`the ${name} image ${ref} did not export as an OCI layout`);
            }
            handed.layouts[name] = layoutRef(dir, digest);
          }));
          const failed = exported.find((r) => r.status === "rejected");
          if (failed !== undefined) {
            const reason = failed.reason;
            throw reason instanceof BuildStep ? reason : new BuildStep(
              `handing the build its images failed: ${
                reason instanceof Error ? reason.message : reason
              }`,
            );
          }
        }

        let cache: { dir: string; read: Map<string, string> } | null = null;
        // A re-layer starts from an image, so it never asks for a cache. A confined build's own
        // builder can always export one.
        if (opts.cacheDir !== null && spec.relayerFrom === null) {
          if (confined !== null || await canExportCache(stop.signal)) {
            await pruneCacheRoot(opts.cacheDir, spec.timeoutMs + CACHE_GRACE_MS);
            // Resolved once, here: the versions read are the same for every pass of this build,
            // and none is deleted while it runs (`pruneCacheVersions`).
            const read = new Map<string, string>();
            for (const scope of spec.cacheScope.read) {
              for (const stage of ["machine", "environment"]) {
                const current = await currentCacheVersion(scopeDir(opts.cacheDir, scope, stage));
                if (current !== null) read.set(`${scope}/${stage}`, current);
              }
            }
            cache = { dir: opts.cacheDir, read };
          } else if (!narratedCache) {
            narratedCache = true;
            diag.debug("environment_builder.docker.shared_cache", {
              detail: "this daemon uses the classic image store, which cannot export a " +
                "BuildKit cache: builds share the daemon's own build cache, and cache scopes " +
                "are not kept apart (see the docker builder's header)",
            });
          }
        }
        const first = machineArgvs(spec, dirs, cache, opts.platform, confined, prefix);
        exports = cache !== null && spec.cacheScope.write !== null
          ? {
            machine: scopeDir(cache.dir, spec.cacheScope.write, "machine"),
            environment: scopeDir(cache.dir, spec.cacheScope.write, "environment"),
          }
          : null;
        if (exports !== null) {
          for (const stage of ["machine", "environment"] as const) {
            await seedCacheVersion(exports[stage], version(stage)).catch((err) =>
              diag.warn("environment_builder.docker.cache_seed_failed", { err: String(err) })
            );
          }
        }

        if (first.machine !== null) {
          if (confined === null) {
            // The universal image under its public name, pointing at the deployment's pinned
            // copy, so a `.ryph/Dockerfile` that says `FROM quay.io/ryph/ryph-universal:1`
            // builds on what this deployment runs. Pulled first when it is not local yet.
            await present(spec.baseImage, "the base image");
            // By the id it resolves to now, judged again: these names are read by every build
            // on the daemon, so they must never come to name an environment image.
            const base = await inputRef("base image", spec.baseImage);
            for (const tag of UNIVERSAL_IMAGE_TAGS) {
              await step("tagging the base image failed", "docker", ["tag", base, tag]);
            }
            machineBuilt = true;
          }
          log.say(`building ${spec.dockerfileFrom}/.ryph/Dockerfile`);
          await step(
            `building ${spec.dockerfileFrom}'s .ryph/Dockerfile failed`,
            "docker",
            first.machine,
          );
          if (exports !== null) await promote("machine");
        }

        // Which machine this is, by its local image id, and — for an incremental build — whether
        // the image it would start from was built on it. One that was not, or that says nothing
        // (older than the record), is built from scratch instead.
        // Without a Dockerfile the machine is the base, named as the other builders name it; with
        // one, the image just built, by the id an unchanged one keeps when built again from the
        // daemon's cache — or, confined, by the digest of the layout it was written to, which an
        // unchanged one built again from the scoped cache keeps (measured, BuildKit 0.32).
        let machineDigest = "";
        let warm = false;
        if (spec.relayerFrom === null && first.machine === null) {
          machineDigest = pinnedDigest(spec.baseImage);
        } else if (spec.relayerFrom === null && confined !== null) {
          machineDigest = await layoutDigest(machineLayout(dirs)) ?? "";
          if (machineDigest === "") throw new BuildStep("the machine build wrote no image");
          confined.layouts.machine = layoutRef(machineLayout(dirs), machineDigest);
        } else if (spec.relayerFrom === null) {
          const inspected = await run(
            "docker",
            ["image", "inspect", "-f", "{{.Id}}", machineTag(spec, prefix)],
            { signal: stop.signal },
          );
          machineDigest = inspected.code === 0 ? inspected.stdout.trim() : "";
        }
        if (first.record !== null && machineDigest !== "") {
          const read = await run("docker", first.record, { signal: stop.signal });
          const recorded = read.code === 0
            ? (await readFile(`${dirs.record}/${MACHINE_RECORD_FILE}`, "utf8").catch(() => ""))
              .trim()
            : "";
          warm = recorded === machineDigest;
          if (warm) log.say(`building incrementally on ${spec.warmFrom}`);
          else if (recorded !== "") {
            log.say(
              "the machine changed since the image this would build on; building from scratch",
            );
          } else {
            // Not a changed machine: an image older than the record, or one that could not be read.
            log.say("the image this would build on could not be read; building from scratch");
            log.append(logTail(`${read.stdout}\n${read.stderr}`, 5));
          }
        }
        const argv = buildArgvs(
          spec,
          dirs,
          cache,
          opts.platform,
          { warm, machineDigest },
          confined,
          prefix,
        );

        log.say("building the environment");
        tagged.push(environmentTag(spec, prefix));
        await step("the environment build failed", "docker", argv.environment);
        if (exports !== null && !warm) await promote("environment");
        if (argv.baked !== null) {
          tagged.push(bakedTag(spec, prefix));
          await step("keeping the baked stage failed", "docker", argv.baked);
        }
        await step("reading the toolchain record failed", "docker", argv.toolchains);
        const baked = spec.relayerFrom ?? bakedTag(spec, prefix);

        const imageId = confined === null
          ? (await readFile(dirs.iidfile, "utf8")).trim()
          : (await run("docker", [
            "image",
            "inspect",
            "-f",
            "{{.Id}}",
            environmentTag(spec, prefix),
          ], {
            signal: stop.signal,
          })).stdout.trim();
        if (!isDigest(imageId)) {
          throw new BuildStep(`the build reported no image id (${JSON.stringify(imageId)})`);
        }
        const toolchains = parseToolchains(
          await readFile(`${dirs.toolchains}/${TOOLCHAINS_FILE}`, "utf8").catch(() => "{}"),
        );
        // Beside the record, and optional: an image baked before ryph-bake wrote it has none.
        const setupWarnings = parseSetupWarnings(
          await readFile(`${dirs.toolchains}/${SETUP_WARNINGS_FILE}`, "utf8").catch(() => null),
        );
        const size = await run("docker", ["image", "inspect", "-f", "{{.Size}}", imageId], {
          signal: stop.signal,
        });
        const sizeBytes = size.code === 0 && /^\d+$/.test(size.stdout.trim())
          ? Number(size.stdout.trim())
          : null;

        const image = imageId;

        succeeded = true;
        log.say(`built ${image}`);
        diag.debug("environment_builder.docker.built", {
          environmentId: spec.environmentId,
          image,
          sizeBytes,
        });
        return {
          ok: true,
          image,
          bakedImage: baked,
          sizeBytes,
          toolchains,
          setupWarnings,
          warm,
          log: log.text(),
        };
      } catch (err) {
        // A command run outside `step` (an inspect) throws the abort itself on a timeout or a
        // cancel: that is the build stopping, not a fault in this adapter.
        if (!(err instanceof BuildStep) && !(stopped !== null && stop.signal.aborted)) throw err;
        const failure = err instanceof BuildStep ? err.message : String(err);
        const kind = stopped === "timeout" ? "timeout" : "failed";
        // Every pass names the gate by the address it had when the build began. A gate a run
        // launch replaced since (`ensureGate`: its drift could not wait) may have another, and
        // then each fetch after that went nowhere — said, since the failure itself cannot say it.
        const moved = stopped === null && gateAt !== null
          ? await gateAddressNow(gateAt.gate, gateAt.network)
          : undefined;
        const message = stopped === "timeout"
          ? `the build ran past its ${Math.round(spec.timeoutMs / 60_000)} minute limit`
          : stopped === "cancelled"
          ? "the build was cancelled"
          : gateAt !== null && moved !== undefined && moved !== gateAt.address
          ? `${failure} — the run gate ${gateAt.gate} was replaced during the build ` +
            `(${gateAt.address} → ${moved ?? "no address"}), so its proxy went away; build it again`
          : failure;
        log.say(message);
        return { ok: false, kind, message, logTail: log.tail(), log: log.text() };
      } finally {
        running.delete(spec.environmentId);
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        // Each bounded, so a wedged daemon cannot hold the build open after it ended.
        const cleanup = () => ({ signal: AbortSignal.timeout(REMOVE_TIMEOUT_MS) });
        if (machineBuilt) {
          // The machine lives on as the environment's lower layers; only its name goes.
          await run("docker", ["image", "rm", machineTag(spec, prefix)], cleanup()).catch(() => {});
        }
        if (builder !== null) {
          // The build's BuildKit, its state and its cache with it: nothing of one build is left
          // for the next to find.
          await removeBuilder(run, builder, () => cleanup().signal);
        }
        if (buildNetwork !== null && opts.confine !== undefined) {
          await removeBuildNetworks(
            run,
            spec.environmentId,
            opts.confine.docker,
            () => cleanup().signal,
          );
        }
        await rm(root, { recursive: true }).catch((err) =>
          diag.warn("environment_builder.docker.cleanup_failed", { root, err: String(err) })
        );
        // What a build that failed, timed out or was cancelled had already tagged: no row will
        // record it, so nothing would ever retire it.
        if (!succeeded) {
          for (const tag of tagged) {
            await run("docker", ["image", "rm", tag], {
              signal: AbortSignal.timeout(REMOVE_TIMEOUT_MS),
            })
              .catch(() => {});
          }
        }
        // An export nobody promoted: half written, or of a build that failed after it.
        if (exports !== null) {
          for (const stage of ["machine", "environment"] as const) {
            if (promoted.has(stage)) continue;
            await rm(version(stage), { recursive: true }).catch(() => {});
          }
        }
      }
    },
  };
}

/** The gate's address on a network, from `docker inspect -f '{{json .NetworkSettings.Networks}}'`. */
export function gateAddress(networksJson: string, network: string): string | null {
  try {
    const address = JSON.parse(networksJson)?.[network]?.IPAddress;
    return typeof address === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(address) ? address : null;
  } catch {
    return null;
  }
}

/** The image an OCI layout's index names first, or null when it names none. */
async function layoutDigest(dir: string): Promise<string | null> {
  try {
    const index = JSON.parse(await readFile(`${dir}/index.json`, "utf8"));
    const digest = index?.manifests?.[0]?.digest;
    return typeof digest === "string" && isDigest(digest) ? digest : null;
  } catch {
    return null;
  }
}
