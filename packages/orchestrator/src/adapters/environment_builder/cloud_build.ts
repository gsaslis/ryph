// The Cloud Build `EnvironmentBuilder`: one build per environment, in a private worker pool
// peered into the deployment's network, running the same BuildKit script the kubernetes builder
// runs (buildkit_script.ts) — but rootful, on a VM of its own, instead of rootless under gVisor.
//
// Why this backend exists, MEASURED on GKE Autopilot: under gVisor rootless BuildKit only works with
// the `native` snapshotter, which copies a step's whole parent for every step — 50-80GB copied
// per build, 679 s for the harness `COPY` alone, 24-44 minutes a cold build. A Cloud Build step
// is root with every capability (measured 2026-09-29: uid 0, CapEff 0000003fffffffff), so
// buildkitd starts as itself with overlayfs and a process sandbox, and a copy is a copy again.
// The boundary is stronger too: a repo's `RUN` steps run on a Google VM that exists for this one
// build, not on a node beside runs.
//
// A build is three steps sharing one volume at `WORK`:
//   - `prepare`, on the BuildKit image, as root: opens the volume to the next step's user (a step
//     volume is created root-owned, and the universal image runs as `runner`), and writes the
//     other two steps' scripts onto it (`scriptFiles`: Cloud Build caps one step argument at
//     10000 characters, which a script alone outgrows)
//   - `clone`, on the deployment's universal image (git and bash are two of its promises): writes
//     the outer Dockerfile and clones every checkout with the build's git credential. It holds
//     the credential; the build step never does
//   - `build`, on the rootful BuildKit image: the shared script, which pushes the images and
//     prints `@@ryph-result` lines
// The result is read from the `build` step's OUTPUT (`results.buildStepOutputs`), which Cloud
// Build fills from a file in the step container that no `RUN` step can reach, and which nobody can
// change afterwards. Never from the log: a log is an object in a bucket, and a build's own identity
// can be made to write buckets — a branch build that stole its token and rewrote another build's
// log would otherwise hand the control plane a digest of its choosing. The log is for reading.
//
// The worker pool has no public egress. The two addresses a build dials of ours — the git
// gateway for the clone, and the egress proxy for everything a step fetches — are internal load
// balancers reachable over the pool's peering (RYPH_ENV_GIT_GATEWAY_URL, RYPH_ENV_EGRESS_PROXY_URL).
// No public egress still reaches Google's APIs and the metadata server, so the steps themselves
// are confined to the proxy (`ScriptOptions.confineSteps`): a step's way out is exactly a run's,
// the proxy under a claim at the deployment's ceiling, and a step never holds the build's token.
//
// The build is also this backend's DURABLE RECORD, which is what `adopt` rests on: it carries a
// tag derived from the environment id alone, so a control plane that never started it can list
// it, watch it to its end and read its log, exactly as the one that created it would have.
//
// Invariants:
// - a default-branch build and a branch build run as two service accounts pushing to two
//   registries, as on kubernetes. Confined steps cannot reach the metadata server, so the split is
//   the second line here rather than the only one: a step that got out of the confinement would
//   still hold only its own branch's identity
// - the result is read ONLY from the `build` step's output, never from a log (see above), and
//   only from its lines that start with `@@ryph-result`
// - default-branch and branch builds log to two buckets, each writable by its own identity only,
//   so even a branch build that reached its token could rewrite no default-branch build's log
// - the git credential and the egress claim ride the build's step env, which the Cloud Build API
//   shows to anyone who may read builds in the project. Both are minted per build and die with
//   it (the git key is revoked when the row settles, the claim expires). The control plane may
//   read builds too, and one identity serves every cell's (docs/environment-builders.md)
// - discard CANCELS a build that is still running; a finished build's record is Cloud Build's to
//   keep, and costs nothing
// - what a build pushed is taken back out of the registries by the control plane's identity, never
//   a build's (artifact_registry.ts): `removeImages` once the core says nothing needs it,
//   `pruneCache` for layer-cache exports a newer one replaced, `reconcileImages` for what is left
//   untagged. A build's identities can push and cannot delete

import type {
  AdoptResult,
  AdoptSpec,
  BuildResult,
  BuildSpec,
  EnvironmentBuilder,
} from "../../ports/environment_builder.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import { assertBuildable, BuildLog, failureLine, proxyBuildArgs, safeName } from "./dockerfile.ts";
import {
  buildScript,
  initArgs,
  initScript,
  readScriptResult,
  type ScriptOptions,
  STEP_NO_PROXY,
  WORK,
} from "./buildkit_script.ts";
import { gcKeepStorage } from "./kubernetes.ts";
import { GoogleApiError, googleRequest, metadataToken } from "./google_api.ts";
import { artifactRegistryCleaner } from "./artifact_registry.ts";
import { shellBody, shellConstants } from "../../helpers/shell.ts";
import WRITE_SCRIPTS_SH from "./sh/write-scripts.sh" with { type: "text" };

/** Upstream's rootful release, pinned. A deployment points RYPH_ENV_BUILDKIT_IMAGE at a copy
 * mirrored into its own registry, since the pool cannot reach Docker Hub. */
export const DEFAULT_ROOTFUL_BUILDKIT_IMAGE =
  "moby/buildkit:v0.32.2@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8";

/**
 * Where a deployment keeps its copy of that image: `<registry>/buildkit:<upstream tag>`. A pool
 * with no public egress cannot pull from Docker Hub, so a deployment mirrors it here and pins the
 * mirror by digest.
 */
export function buildkitMirror(registry: string): { ref: string; source: string } {
  const tag = DEFAULT_ROOTFUL_BUILDKIT_IMAGE.split("@")[0].split(":")[1];
  return {
    ref: `${registry.replace(/\/+$/, "")}/buildkit:${tag}`,
    source: DEFAULT_ROOTFUL_BUILDKIT_IMAGE,
  };
}

/** The step that runs the script, and its place in `buildRequest`'s steps. */
const BUILD_STEP = "build";
const BUILD_STEP_INDEX = 2;

/** Cloud Build's terminal statuses, and the one that is a success. */
const TERMINAL = new Set([
  "SUCCESS",
  "FAILURE",
  "INTERNAL_ERROR",
  "TIMEOUT",
  "CANCELLED",
  "EXPIRED",
]);

/** How much of a running build's log one live read fetches: its end, where the build is. */
const LIVE_LOG_BYTES = 256 * 1024;

/** How long a finished build's log may take to appear in the bucket before it is given up on. */
const LOG_WAIT_MS = 30_000;

export interface CloudBuildOptions {
  /** The worker pool, `projects/<project>/locations/<region>/workerPools/<name>`
   * (RYPH_ENV_CLOUD_BUILD_POOL). Builds are created in its project and region. */
  pool: string;
  /** The bucket a default-branch build's log is written to (RYPH_ENV_CLOUD_BUILD_LOGS). */
  logsBucket: string;
  /** A branch build's (RYPH_ENV_CLOUD_BUILD_BRANCH_LOGS), which only the branch identity writes. */
  branchLogsBucket: string;
  /** The service account a default-branch build runs as (RYPH_ENV_CLOUD_BUILD_SERVICE_ACCOUNT). */
  serviceAccount: string;
  /** A branch build's (RYPH_ENV_CLOUD_BUILD_BRANCH_SERVICE_ACCOUNT): cannot write `registry`. */
  branchServiceAccount: string;
  /** `RYPH_ENV_REGISTRY` and `RYPH_ENV_BRANCH_REGISTRY`, as on kubernetes. */
  registry: string;
  branchRegistry: string;
  /** The rootful BuildKit image the `build` step runs (RYPH_ENV_BUILDKIT_IMAGE). */
  buildkitImage: string;
  /** The pool's disk (RYPH_ENV_CLOUD_BUILD_DISK, e.g. `500Gi`), for buildkitd's GC policy; see
   * `gcKeepStorage`. Null: buildkitd's own defaults. */
  disk: string | null;
  /** How often a running build is looked at. */
  pollIntervalMs?: number;
  /** A cap on each API request, so a connection that hangs cannot hold a build slot for ever. */
  requestTimeoutMs?: number;
  /** How long a finished build's log may take to appear in the bucket (LOG_WAIT_MS). */
  logWaitMs?: number;
}

export interface CloudBuildDeps {
  fetch?: typeof fetch;
  /** An OAuth access token for the Google APIs; defaults to the metadata server's (Workload
   * Identity on GKE). */
  token?: () => Promise<string>;
}

/** `projects/<p>/locations/<l>/workerPools/<n>` → its project and region, or null. */
export function parsePool(pool: string): { project: string; location: string } | null {
  const match = pool.match(
    /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/locations\/([a-z0-9-]+)\/workerPools\/[a-z0-9-]+$/,
  );
  return match === null ? null : { project: match[1], location: match[2] };
}

/** Where a build's log goes: each identity writes only its own bucket. */
export function logsBucketFor(
  spec: Pick<BuildSpec, "defaultBranch">,
  opts: Pick<CloudBuildOptions, "logsBucket" | "branchLogsBucket">,
): string {
  return spec.defaultBranch ? opts.logsBucket : opts.branchLogsBucket;
}

/**
 * The `build` step's output: the script's result lines, as Cloud Build recorded them. Base64 in
 * the API, one entry per step in step order; empty for a step that wrote none.
 */
export function stepOutput(build: CloudBuild, step: number): string {
  const encoded = build.results?.buildStepOutputs?.[step] ?? "";
  if (encoded === "") return "";
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

/** The tag that names one environment's build — how `adopt` finds a build it did not start. */
export function buildTag(environmentId: string): string {
  return `ryph-env-${safeName(environmentId, 100)}`;
}

/**
 * The shared script's view of this backend: rootful, as the build's own service account, with
 * its steps confined to the egress proxy the spec names — the only way out a run has, and the
 * only one a step gets, where the worker itself could reach Google's APIs and the build's token.
 */
export function cloudBuildScriptOptions(
  opts: CloudBuildOptions,
  spec: Pick<BuildSpec, "proxyEnv">,
): ScriptOptions {
  return {
    registry: opts.registry,
    branchRegistry: opts.branchRegistry,
    registryAuth: "gke-metadata",
    daemon: "rootful",
    confineSteps: { proxy: proxyAddress(spec.proxyEnv) },
  };
}

/** The host and port a spec's HTTPS proxy is at, or null when it names none. */
export function proxyAddress(
  proxyEnv: Record<string, string>,
): { host: string; port: number } | null {
  const raw = proxyEnv.HTTPS_PROXY ?? proxyEnv.https_proxy;
  const url = raw === undefined ? null : URL.parse(raw);
  if (url === null || url.hostname === "") return null;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return { host: url.hostname, port };
}

/** Cloud Build's cap on one step argument (measured 2026-09-30: "build step 2 arg 1 too long
 * (max: 10000)", on the first incremental build's script). */
export const MAX_STEP_ARG = 10_000;

/** A raw chunk's length, in UTF-16 units. Each becomes at most three UTF-8 bytes, `literal`'s `$$`
 * included, so a chunk stays under `MAX_STEP_ARG` whether Cloud Build counts bytes or characters. */
const SCRIPT_CHUNK = 3_000;

/** Where `prepare` writes the script a step runs: root's, and only read by the steps after it. */
export function stepScriptPath(id: string): string {
  return `${WORK}/steps/${id}.sh`;
}

/**
 * The `prepare` step's arguments to write scripts onto the volume: each file as its path, its
 * chunk count and its chunks, since no one argument may hold a whole script. Chunks are cut
 * before `literal`, so a `$$` escape is never split across two, and never inside a surrogate pair.
 */
export function scriptFiles(scripts: Array<[string, string]>): string[] {
  const args: string[] = [];
  for (const [path, script] of scripts) {
    const chunks: string[] = [];
    for (let at = 0; at < script.length;) {
      let end = Math.min(at + SCRIPT_CHUNK, script.length);
      if (end < script.length && /[\uD800-\uDBFF]/.test(script[end - 1])) end -= 1;
      chunks.push(script.slice(at, end));
      at = end;
    }
    args.push(path, String(chunks.length), ...chunks);
  }
  return args.map(literal);
}

/** What `prepare` runs over `scriptFiles`' arguments (sh/write-scripts.sh). */
export const WRITE_SCRIPTS = [shellConstants({ RYPH_WORK: WORK }), shellBody(WRITE_SCRIPTS_SH)]
  .join("\n");

/**
 * A string as Cloud Build must be handed it: it reads `$NAME` and `${NAME}` in a step's args and
 * env as ITS substitutions, and refuses a build that names one it does not know (measured
 * 2026-09-29: "key in the template "BUILDER_OUTPUT" is not a valid built-in substitution").
 * `$$` is its escape for a literal `$`, and every `$` here is the shell's.
 */
export function literal(value: string): string {
  return value.replaceAll("$", "$$$$");
}

/**
 * The build one environment creates. Pure, and exported for the test: with the script, it is the
 * contract between the control plane and Cloud Build.
 */
export function buildRequest(spec: BuildSpec, opts: CloudBuildOptions) {
  const where = parsePool(opts.pool)!;
  const volumes = [{ name: "work", path: WORK }];
  const kv = (entries: Array<[string, string]>) => entries.map(([k, v]) => literal(`${k}=${v}`));

  // What the build step's buildkitd sees of the way out. The metadata server, which only the
  // credential helper dials, and the registries: a pool worker reaches Google's APIs without
  // public egress (measured 2026-09-29: Artifact Registry answered a worker directly), so image
  // pulls and pushes — gigabytes a build — go straight there rather than through the cluster's
  // proxy. A build STEP sees the spec's own NO_PROXY and nothing more: its way out is the claim.
  const proxy = proxyBuildArgs(spec.proxyEnv);
  const isNoProxy = (key: string) => key.toUpperCase() === "NO_PROXY";
  const stepNoProxy = spec.proxyEnv.NO_PROXY ?? spec.proxyEnv.no_proxy;
  const registries = [
    opts.registry,
    opts.branchRegistry,
    opts.buildkitImage,
    spec.baseImage,
    spec.harnessImage,
    ...(spec.warmFrom === null ? [] : [spec.warmFrom]),
    ...(spec.relayerFrom === null ? [] : [spec.relayerFrom]),
  ].map((ref) => ref.split("/")[0]).filter((host) => host.includes("."));
  const noProxy = [
    ...new Set([
      stepNoProxy,
      "169.254.169.254",
      "metadata.google.internal",
      ...registries,
    ]),
  ].filter((v): v is string => v !== undefined && v !== "").join(",");
  const noProxyKeys = proxy.map(([k]) => k).filter(isNoProxy);
  if (noProxyKeys.length === 0) noProxyKeys.push("NO_PROXY");
  const gc = gcKeepStorage(opts.disk);

  const account = spec.defaultBranch ? opts.serviceAccount : opts.branchServiceAccount;
  const timeoutSeconds = Math.ceil(spec.timeoutMs / 1000);
  return {
    steps: [
      {
        id: "prepare",
        name: opts.buildkitImage,
        entrypoint: "sh",
        args: [
          "-c",
          literal(WRITE_SCRIPTS),
          "prepare",
          ...scriptFiles([
            [stepScriptPath("clone"), initScript(spec)],
            [stepScriptPath(BUILD_STEP), buildScript(spec, cloudBuildScriptOptions(opts, spec))],
          ]),
        ],
        volumes,
      },
      {
        id: "clone",
        name: spec.baseImage,
        entrypoint: "bash",
        args: [stepScriptPath("clone"), ...initArgs(spec).map(literal)],
        env: kv([
          ["HOME", `${WORK}/home`],
          ["GIT_TERMINAL_PROMPT", "0"],
          ...Object.entries(spec.clone.env).sort(([a], [b]) => a.localeCompare(b)),
        ]),
        volumes,
      },
      {
        id: BUILD_STEP,
        name: opts.buildkitImage,
        entrypoint: "sh",
        args: [stepScriptPath(BUILD_STEP)],
        env: kv([
          ["BUILDKITD_FLAGS", gc === null ? "" : `--oci-worker-gc-keepstorage=${gc}`],
          ...proxy.filter(([k]) => !isNoProxy(k)),
          ...noProxyKeys.map((k): [string, string] => [k, noProxy]),
          ...(stepNoProxy === undefined ? [] : [[STEP_NO_PROXY, stepNoProxy] as [string, string]]),
        ]),
        volumes,
      },
    ],
    // Cloud Build's own cap, a little past the core's, as `activeDeadlineSeconds` is on a Job: the
    // backstop for a control plane that is not there to cancel it.
    timeout: `${timeoutSeconds + 120}s`,
    // A pool at capacity queues the build; one that waits this long is not coming.
    queueTtl: `${timeoutSeconds}s`,
    serviceAccount: `projects/${where.project}/serviceAccounts/${account}`,
    logsBucket: `gs://${logsBucketFor(spec, opts)}`,
    options: { pool: { name: opts.pool }, logging: "GCS_ONLY" },
    tags: ["ryph-environment", buildTag(spec.environmentId)],
  };
}

/**
 * The `build` step's own lines out of a Cloud Build log, with Cloud Build's prefix taken off —
 * what the script printed, the same text the kubernetes builder reads out of its pod log.
 */
export function stepLines(log: string, step: string): string {
  const prefix = new RegExp(`^Step #\\d+ - "${step}": ?`);
  const lines: string[] = [];
  for (const line of log.split("\n")) {
    const match = prefix.exec(line);
    if (match !== null) lines.push(line.slice(match[0].length));
  }
  return lines.join("\n");
}

/**
 * A Cloud Build log as a person reads it: each step's lines without the `Step #n - "id": ` prefix
 * Cloud Build puts on every one of them, the `Starting Step` headings left to say which is which.
 */
export function readableLog(raw: string): string {
  return raw.replace(/^Step #\d+ - "[^"]*": ?/gm, "");
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

export interface CloudBuild {
  id: string;
  status: string;
  statusDetail?: string;
  createTime?: string;
  failureInfo?: { type?: string; detail?: string };
  results?: { buildStepOutputs?: string[] };
}

export function cloudBuildEnvironmentBuilder(
  opts: CloudBuildOptions,
  diag: Diagnostics,
  deps: CloudBuildDeps = {},
): EnvironmentBuilder {
  const where = parsePool(opts.pool);
  if (where === null) {
    throw new Error(
      `RYPH_ENV_CLOUD_BUILD_POOL must be projects/<project>/locations/<region>/workerPools/<name>, ` +
        `got ${JSON.stringify(opts.pool)}`,
    );
  }
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const token = deps.token ?? metadataToken(fetchImpl);
  const pollMs = opts.pollIntervalMs ?? 10_000;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
  /** Environment id → build id, for the live log's repeated asks. */
  const liveIds = new Map<string, string>();
  const builds =
    `https://cloudbuild.googleapis.com/v1/projects/${where.project}/locations/${where.location}/builds`;
  // What a build pushed, taken out of the registries once the core says so — as the control
  // plane's identity, which may delete there (its IAM is the deployment's to grant; environment-builders.md); a build's own may not.
  const cleaner = artifactRegistryCleaner(
    { registry: opts.registry, branchRegistry: opts.branchRegistry, requestTimeoutMs },
    diag,
    { fetch: fetchImpl, token },
  );

  const call = (method: string, url: string, body?: unknown): Promise<unknown> =>
    googleRequest({ fetch: fetchImpl, token, timeoutMs: requestTimeoutMs }, method, url, body);

  /** The row is written, or the build superseded: a build still running is cancelled. A finished
   * one is left as it is — its record is Cloud Build's history, and costs nothing. */
  async function discard(environmentId: string): Promise<void> {
    const found = await find(environmentId);
    if (found === null || TERMINAL.has(found.status)) return;
    await call("POST", `${builds}/${found.id}:cancel`, {}).catch((err) => {
      // Cancelling a build that finished in between is not an error.
      if (!(err instanceof GoogleApiError && err.status === 400)) throw err;
    });
    diag.debug("environment_builder.cloud_build.cancelled", { environmentId, build: found.id });
  }

  /** The newest build carrying this environment's tag, or null. */
  async function find(environmentId: string): Promise<CloudBuild | null> {
    const filter = encodeURIComponent(`tags="${buildTag(environmentId)}"`);
    const listed = await call("GET", `${builds}?filter=${filter}&pageSize=5`) as
      | { builds?: CloudBuild[] }
      | null;
    const found = (listed?.builds ?? []).sort((a, b) =>
      (b.createTime ?? "").localeCompare(a.createTime ?? "")
    );
    return found[0] ?? null;
  }

  /** The build's log, from the bucket; retried briefly, since it lands a moment after the end. */
  async function readLog(
    id: string,
    bucket: string,
    signal: AbortSignal,
    { waitMs = opts.logWaitMs ?? LOG_WAIT_MS, lastBytes }: { waitMs?: number; lastBytes?: number } =
      {},
  ): Promise<string | null> {
    const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${
      encodeURIComponent(`log-${id}.txt`)
    }?alt=media`;
    const until = Date.now() + waitMs;
    while (true) {
      try {
        const res = await fetchImpl(url, {
          headers: {
            authorization: `Bearer ${await token()}`,
            ...(lastBytes === undefined ? {} : { range: `bytes=-${lastBytes}` }),
          },
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        // 416: a range past an object still empty — nothing to show yet.
        if (res.status === 416) {
          await res.body?.cancel();
          return null;
        }
        // A range read starts wherever the byte count fell: mid-line, maybe mid-character. The
        // first line of it is dropped rather than shown broken.
        if (res.status === 206) {
          const text = await res.text();
          return text.slice(text.indexOf("\n") + 1);
        }
        if (res.ok) return await res.text();
        await res.body?.cancel();
        if (res.status !== 404) {
          diag.warn("environment_builder.cloud_build.log_read_failed", { id, status: res.status });
          return null;
        }
      } catch (err) {
        diag.warn("environment_builder.cloud_build.log_read_failed", { id, err: String(err) });
      }
      if (Date.now() >= until || signal.aborted) return null;
      await pause(2000, signal);
    }
  }

  /**
   * A build from wherever it is now to its verdict: watched until it ends, its log read, and the
   * result lines turned into a result. The second half of a build and the whole of an adoption,
   * as on kubernetes.
   */
  async function finish(
    id: string,
    spec: AdoptSpec,
    log: BuildLog,
    signal: AbortSignal,
    deadline: number,
  ): Promise<BuildResult> {
    const fail = (kind: "failed" | "timeout", message: string): BuildResult => {
      log.say(message);
      return { ok: false, kind, message, logTail: log.tail(), log: log.text() };
    };
    let current: CloudBuild | null = null;
    let outcome: "done" | "timeout" | "cancelled" | null = null;
    while (outcome === null) {
      if (signal.aborted) outcome = "cancelled";
      else if (Date.now() >= deadline) outcome = "timeout";
      else {
        try {
          current = await call("GET", `${builds}/${id}`) as CloudBuild;
          if (TERMINAL.has(current.status)) outcome = "done";
        } catch (err) {
          // A blip on the API is not a failed build; the deadline still bounds this.
          diag.warn("environment_builder.cloud_build.poll_failed", { id, err: String(err) });
        }
        if (outcome === null) {
          await pause(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
        }
      }
    }
    if (outcome !== "done") {
      // Whatever stopped the watching stops the build: a timeout or a cancel leaves nothing
      // running, as the port asks.
      await call("POST", `${builds}/${id}:cancel`, {}).catch(() => {});
    }

    const bucket = logsBucketFor(spec, opts);
    const raw = await readLog(id, bucket, new AbortController().signal);
    if (raw !== null) log.append(readableLog(raw));
    else log.say(`the log of build ${id} could not be read from gs://${bucket}`);
    const script = raw === null ? "" : stepLines(raw, BUILD_STEP);

    if (outcome === "timeout" || current?.status === "TIMEOUT") {
      return fail(
        "timeout",
        `the build ran past its ${Math.round(spec.timeoutMs / 60_000)} minute limit`,
      );
    }
    if (outcome === "cancelled") return fail("failed", "the build was cancelled");
    if (current!.status !== "SUCCESS") {
      const clone = raw === null ? "" : stepLines(raw, "clone");
      const why = failureLine(`${clone}\n${script}`) ?? current!.failureInfo?.detail ??
        current!.statusDetail ?? null;
      return fail(
        "failed",
        `the environment build failed (${current!.status})${why ? `: ${why}` : ""}`,
      );
    }
    // The step's index in `buildRequest`, which is fixed: prepare, clone, build.
    const read = readScriptResult(stepOutput(current!, BUILD_STEP_INDEX), spec, opts);
    if (!read.ok) return fail("failed", read.message);
    log.say(`built ${read.image}`);
    diag.debug("environment_builder.cloud_build.built", {
      environmentId: spec.environmentId,
      image: read.image,
      build: id,
    });
    return {
      ok: true,
      image: read.image,
      bakedImage: read.bakedImage,
      machineImage: read.machineImage,
      sizeBytes: null,
      toolchains: read.toolchains,
      setupWarnings: read.setupWarnings,
      warm: read.warm,
      log: log.text(),
    };
  }

  return {
    kind: "cloud-build",

    discard,

    ...(cleaner === null ? {} : {
      removeImages: cleaner.removeBuild,
      pruneCache: (prune: { retiredForMs: number }) => cleaner.pruneCache(prune.retiredForMs),
      reconcileImages: cleaner.reconcileImages,
      removalStats: cleaner.removalStats,
    }),

    /** The log object as far as Cloud Build has written it. Any replica can read it. */
    async liveLog(spec): Promise<string | null> {
      try {
        // Asked every few seconds by every page watching the build: the build's id is looked up
        // once, and only the end of the log object is read.
        let id = liveIds.get(spec.environmentId);
        if (id === undefined) {
          const found = await find(spec.environmentId);
          if (found === null) return null;
          id = found.id;
          if (liveIds.size >= 256) liveIds.clear();
          liveIds.set(spec.environmentId, id);
        }
        const raw = await readLog(id, logsBucketFor(spec, opts), new AbortController().signal, {
          waitMs: 0,
          lastBytes: LIVE_LOG_BYTES,
        });
        return raw === null ? null : readableLog(raw);
      } catch {
        return null;
      }
    },

    async build(spec: BuildSpec, { signal }): Promise<BuildResult> {
      assertBuildable(spec);
      const log = new BuildLog();
      log.say(`environment ${spec.environmentId} for ${spec.subjectKey}: cloud build`);
      let id: string;
      try {
        const created = await call("POST", builds, buildRequest(spec, opts)) as {
          metadata?: { build?: { id?: string } };
        };
        const createdId = created?.metadata?.build?.id;
        if (!createdId) throw new Error("Cloud Build created a build but returned no id");
        id = createdId;
      } catch (err) {
        // Refused, or the answer was lost: a create that timed out may still have started a
        // build, so whatever carries this environment's tag is cancelled on the way out.
        await discard(spec.environmentId).catch((cancel) =>
          diag.warn("environment_builder.cloud_build.discard_failed", {
            environmentId: spec.environmentId,
            err: String(cancel),
          })
        );
        const message = `could not start the build: ${err instanceof Error ? err.message : err}`;
        log.say(message);
        return { ok: false, kind: "failed", message, logTail: log.tail(), log: log.text() };
      }
      log.say(`build ${id} in ${opts.pool}`);
      diag.debug("environment_builder.cloud_build.started", {
        environmentId: spec.environmentId,
        build: id,
      });
      return await finish(id, spec, log, signal, Date.now() + spec.timeoutMs);
    },

    async adopt(spec: AdoptSpec, { signal }): Promise<AdoptResult> {
      let found: CloudBuild | null;
      try {
        found = await find(spec.environmentId);
      } catch (err) {
        // Not an answer: saying `gone` to an API that did not answer would fail a build that is
        // running perfectly well.
        return { kind: "unknown", why: err instanceof Error ? err.message : String(err) };
      }
      if (found === null) return { kind: "gone" };
      const log = new BuildLog();
      log.say(
        `environment ${spec.environmentId} for ${spec.subjectKey}: adopted build ${found.id}`,
      );
      diag.warn("environment_builder.cloud_build.adopted", {
        environmentId: spec.environmentId,
        build: found.id,
      });
      // Cloud Build's own timeout, set when the build was created, is what really bounds it; this
      // is only the watcher's backstop, generous because the adopter cannot know what was spent.
      return {
        kind: "settled",
        result: await finish(found.id, spec, log, signal, Date.now() + spec.timeoutMs),
      };
    },
  };
}
