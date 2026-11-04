// The docker launcher's wire: the routes,
// and the schema of every body that crosses them, in one place both ends import — the server in
// @ryph/launcher, the clients beside this file.
//
// Every request schema exists twice, from the one definition below: STRICT, which the launcher
// parses with and which refuses any key it does not know, and LAX, which a client parses its own
// spec with before sending. The lax pass validates the caller's half (a bad spec fails in the
// process that built it, naming the field) and strips whatever a core object carries beyond the
// port's fields, so a strict server never refuses a launch over an extra key nobody meant to send.
//
// The schemas are also where the launcher DECIDES. A request carries only the port's own spec,
// and every field of it that reaches a docker argv, a path on the launcher's disk or the cloning
// git's environment is held to what the core would ever send:
// - images, refs and names never start with `-`: each lands in an argv where a leading dash is a
//   flag, and `docker run … --privileged` is root on the host
// - a service container's capabilities come from the core's allowlist (SERVICE_CAPABILITIES) and
//   nothing else, and it never escalates
// - checkout paths and cache scopes are single safe path segments: they name directories under
//   the launcher's temp and cache roots
// - a build's clone credential is exactly the one `GIT_CONFIG_*` extraheader the core mints, and
//   its URLs are http(s): any other git config there (a `core.sshCommand`, `protocol.ext.allow`)
//   would run a command in the process holding the docker socket
// - a proxy env is the six proxy variables and nothing else
// - no string holds a NUL: an argv entry or env value cannot, and the spawn's refusal would quote it
// - CPU, memory and disk are numbers in the spellings their adapters read
// Anything else (mounts, privileges, published ports, the runtime, the networks, the gate) is
// not in any schema at all: it is the launcher's own configuration.
//
// The wire's revision is LAUNCHER_WIRE_REVISION (@ryph/mcp-gateway/tool-host, the one constant
// both sides of the wire import): BUMP IT WHENEVER ANY SCHEMA HERE CHANGES. The launcher says it
// in /v1/info, and a caller of another revision refuses to boot (`checkedInfo`).
//
// Long calls (a build, an adoption, a launch that may pull) answer as NDJSON: `{"beat":1}` every
// few seconds while the work runs, then one `{"result":…}` or `{"error":…,"message":…}`. The
// beats keep every idle timeout between the two ends (a proxy's, a client's) from cutting a build
// that is merely slow, and let the client tell a launcher that died from one still working.

import { z } from "@zod/zod";
import type { BrowserLaunch, LaunchSpec, RunSize, ServiceSpec } from "../../ports/provisioner.ts";
import type {
  CheckContainerState,
  CheckInspection,
  CheckSpec,
  ImagesAnswer,
} from "../../ports/check_launcher.ts";
import type {
  AdoptResult,
  AdoptSpec,
  BuildCheckout,
  BuildResult,
  BuildSpec,
  LiveLogSpec,
  RemoveImagesSpec,
} from "../../ports/environment_builder.ts";
import type { PrefetchImage } from "../../ports/image_prefetch.ts";
import { SERVICE_CAPABILITIES } from "../../core/services.ts";

/** Every route, by the scope its token opens. The tool-host routes are @ryph/mcp-gateway's
 * (adapters/tool_host/launcher.ts) and take the other token. */
export const LAUNCHER_ROUTES = {
  info: "/v1/info",
  launch: "/v1/runs/launch",
  kill: "/v1/runs/kill",
  inspect: "/v1/runs/inspect",
  reconcileList: "/v1/reconcile/list",
  reconcileReclaim: "/v1/reconcile/reclaim",
  checksPrepare: "/v1/checks/prepare",
  checksLaunch: "/v1/checks/launch",
  checksPoll: "/v1/checks/poll",
  checksLogs: "/v1/checks/logs",
  checksDiscard: "/v1/checks/discard",
  checksList: "/v1/checks/list",
  build: "/v1/builds/build",
  adopt: "/v1/builds/adopt",
  buildDiscard: "/v1/builds/discard",
  liveLog: "/v1/builds/live-log",
  removeImages: "/v1/builds/remove-images",
  prefetchStatus: "/v1/prefetch/status",
  prefetchStart: "/v1/prefetch/start",
} as const;

/** The one failure with a name on the wire: `ImageGone` (ports/image_gone.ts). */
export const IMAGE_GONE = "image_gone";

/** How often a long call beats; a client that hears nothing for `LONG_CALL_STALL_MS` gives up. */
export const BEAT_MS = 10_000;
export const LONG_CALL_STALL_MS = 60_000;

const MAX = 4096;
/** Every string on the wire: bounded, and never a NUL, which no argv or env value can hold —
 * the spawn would refuse it, quoting the value (a secret, as like as not) in its error. */
const str = (max = MAX) => z.string().max(max).regex(/^[^\0]*$/, "contains a NUL byte");
/** An id the launcher puts in a container name, a label or a tag. */
const safeId = str(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "not a safe id");
/** An image reference: never a flag, never two words. */
const image = str(512).regex(/^[^\s-][^\s]*$/, "not an image reference");
const sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "not a commit id");
/** A git ref or branch name: never a flag, no whitespace, no `..`. */
const gitRef = str(255).regex(/^[^\s-][^\s]*$/, "not a ref").refine((v) => !v.includes(".."), {
  message: "not a ref",
});
/** One directory name under the launcher's temp root: what a checkout is baked at. */
const pathSegment = str(128).regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, "not a single path segment");
const httpUrl = str(2048).regex(/^https?:\/\/[^\s]+$/, "not an http(s) URL");
/** Docker's CPU spelling (`1`, `0.5`). */
const dockerCpus = str(16).regex(/^\d+(\.\d+)?$/, "not a CPU count");
/** Docker's memory spelling (`512m`, `1g`). */
const dockerMemory = str(16).regex(/^\d+[bkmgBKMG]?$/, "not a memory size");
/** A Kubernetes quantity (`4`, `500m`, `8Gi`). */
const quantity = str(32).regex(/^\d+(\.\d+)?([mkKMGTPE]i?)?$/, "not a quantity");
const port = z.number().int().min(1).max(65535);
/** Env for a container: names that cannot be a flag or carry an `=`. */
const envMap = z.record(str(256).regex(/^[A-Za-z_][A-Za-z0-9_.]*$/, "not an env name"), str(65536));
const capability = z.string().refine((c) => SERVICE_CAPABILITIES.has(c), {
  message: "not a capability a service container may be granted",
});
const PROXY_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

function build(obj: typeof z.object) {
  const RunSize = obj({
    name: str(64),
    cpu: quantity.nullable(),
    memory: quantity.nullable(),
    ephemeralStorage: quantity.nullable(),
    workVolume: quantity.nullable(),
  }) satisfies z.ZodType<RunSize>;

  const ServiceSpec = obj({
    name: z.string().regex(/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/, "not an RFC 1035 label"),
    image,
    command: z.array(str(MAX)).max(256).optional(),
    env: envMap,
    port,
    security: obj({
      capabilities: z.array(capability).max(32),
      allowPrivilegeEscalation: z.literal(false),
    }),
    resources: obj({ cpus: dockerCpus, memory: dockerMemory }),
  }) satisfies z.ZodType<ServiceSpec>;

  const BrowserLaunch = obj({
    image,
    port,
    resources: obj({ cpu: quantity.nullable(), memory: quantity.nullable() }),
  }) satisfies z.ZodType<BrowserLaunch>;

  const LaunchSpec = obj({
    runId: safeId,
    image: image.nullable(),
    size: RunSize,
    env: envMap,
    deadlineSeconds: z.number().int().nonnegative().optional(),
    services: z.array(ServiceSpec).max(32).optional(),
    browser: BrowserLaunch.nullable().optional(),
  }) satisfies z.ZodType<LaunchSpec>;

  /** The one credential a clone gets: `gitAuthEnv`'s three variables, or none. */
  const GitEnv = z.union([
    obj({
      GIT_CONFIG_COUNT: z.literal("1"),
      GIT_CONFIG_KEY_0: str(2048).regex(/^http\.https?:\/\/[^\s]+\/\.extraheader$/),
      GIT_CONFIG_VALUE_0: str(8192).regex(/^Authorization: [^\r\n]+$/),
    }),
    obj({}),
  ]);
  const ProxyEnv = obj(
    Object.fromEntries(PROXY_KEYS.map((key) => [key, str(MAX).optional()])) as Record<
      (typeof PROXY_KEYS)[number],
      z.ZodOptional<z.ZodString>
    >,
  );

  const CheckSpec = obj({
    suiteId: safeId,
    generation: z.number().int().nonnegative(),
    name: z.string().regex(/^ryph-check-[A-Za-z0-9_.-]+$/, "not a check record name"),
    image,
    clone: obj({ url: httpUrl, env: GitEnv, commit: sha, baseCommit: sha }),
    bakedCheckout: pathSegment.nullable(),
    setup: z.array(obj({ run: str(65536) })).max(64),
    keep: z.array(str(1024)).max(256),
    checks: z.array(obj({
      name: str(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "not a check name"),
      run: str(65536),
      timeoutSeconds: z.number().int().positive(),
    })).max(64),
    services: z.array(ServiceSpec).max(32),
    size: RunSize,
    proxyEnv: ProxyEnv,
    deadlineSeconds: z.number().int().positive(),
  }) satisfies z.ZodType<CheckSpec, unknown>;

  const BuildCheckout = obj({
    path: pathSegment,
    connectedRepoId: safeId,
    ref: gitRef,
    commit: sha,
  }) satisfies z.ZodType<BuildCheckout>;

  const BuildSpec = obj({
    environmentId: safeId,
    subjectKey: safeId,
    dockerfileFrom: pathSegment.nullable(),
    checkouts: z.array(BuildCheckout).max(64),
    baseImage: image,
    harnessImage: image,
    defaultBranch: z.boolean(),
    cacheScope: obj({ read: z.array(safeId).max(16), write: safeId.nullable() }),
    relayerFrom: image.nullable(),
    warmFrom: image.nullable(),
    proxyEnv: ProxyEnv,
    clone: obj({ urls: z.record(pathSegment, httpUrl), env: GitEnv }),
    timeoutMs: z.number().int().positive(),
  }) satisfies z.ZodType<BuildSpec, unknown>;

  const AdoptSpec = obj({
    environmentId: safeId,
    subjectKey: safeId,
    defaultBranch: z.boolean(),
    relayerFrom: image.nullable(),
    timeoutMs: z.number().int().positive(),
  }) satisfies z.ZodType<AdoptSpec>;

  const LiveLogSpec = obj({
    environmentId: safeId,
    defaultBranch: z.boolean(),
  }) satisfies z.ZodType<LiveLogSpec>;

  const RemoveImagesSpec = obj({
    environmentId: safeId,
    subjectKey: safeId,
    defaultBranch: z.boolean(),
    recorded: z.boolean(),
    image: image.nullable(),
    machineImage: image.nullable(),
    bakedImage: image.nullable(),
  }) satisfies z.ZodType<RemoveImagesSpec>;

  /** A container id or name: what `launch` answered, never a flag. */
  const handle = str(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "not a container handle");
  const checkName = CheckSpec.shape.name;

  return {
    LaunchSpec,
    CheckSpec,
    BuildSpec,
    AdoptSpec,
    LiveLogSpec,
    RemoveImagesSpec,
    Launch: obj({ spec: LaunchSpec }),
    Kill: obj({ handle, graceful: z.boolean() }),
    Inspect: obj({ handle }),
    Reclaim: obj({ listing: safeId, active: z.array(str(200)).max(100_000) }),
    ChecksPrepare: obj({ images: z.array(image).max(64), since: str(64) }),
    ChecksLaunch: obj({ spec: CheckSpec }),
    ChecksName: obj({ name: checkName }),
    ChecksLogs: obj({
      name: checkName,
      container: str(160).regex(/^(clone|setup-\d+|check-[A-Za-z0-9][A-Za-z0-9_.-]*)$/),
      maxBytes: z.number().int().positive().max(16 * 1024 * 1024),
    }),
    Build: obj({ spec: BuildSpec }),
    Adopt: obj({ spec: AdoptSpec }),
    BuildDiscard: obj({ environmentId: safeId }),
    LiveLog: obj({ spec: LiveLogSpec }),
    RemoveImages: obj({ spec: RemoveImagesSpec }),
    Empty: obj({}),
  };
}

/** What the launcher parses requests with: an unknown key anywhere is a 400. */
export const strictWire = build(z.strictObject as typeof z.object);
/** What a client parses its own spec with before it sends it: validated, extra keys dropped. */
export const laxWire = build(z.object);

// ---- answers ---------------------------------------------------------------------------------
// Parsed by the clients only: the server builds them from its own adapters' typed answers.

const nstr = z.string().nullable();

export const LaunchAnswer = z.object({ handle: z.string().min(1) });
export const InspectAnswer = z.object({ state: z.enum(["running", "exited", "unknown"]) });

const CheckContainerStateSchema = z.union([
  z.object({ state: z.literal("waiting") }),
  z.object({ state: z.literal("running"), startedAt: nstr }),
  z.object({
    state: z.literal("exited"),
    exitCode: z.number().int(),
    startedAt: nstr,
    finishedAt: nstr,
    reason: nstr,
  }),
]) satisfies z.ZodType<CheckContainerState>;

export const CheckInspectionAnswer = z.union([
  z.object({ kind: z.literal("gone") }),
  z.object({ kind: z.literal("unknown"), why: z.string() }),
  z.object({
    kind: z.literal("pending"),
    cloneDone: z.boolean(),
    why: nstr,
    running: z.union([z.literal("clone"), z.number().int()]).optional(),
  }),
  z.object({ kind: z.literal("unschedulable"), why: nstr, detail: z.string().optional() }),
  z.object({
    kind: z.literal("setup_failed"),
    cloneDone: z.boolean(),
    step: z.union([z.literal("clone"), z.number().int()]),
    exitCode: z.number().int().nullable(),
    why: z.string(),
  }),
  z.object({
    kind: z.literal("checks"),
    checks: z.record(z.string(), CheckContainerStateSchema),
    done: z.boolean(),
  }),
]) satisfies z.ZodType<CheckInspection>;

export const ImagesAnswerSchema = z.union([
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("pulling") }),
  z.object({ kind: z.literal("failed"), why: z.string() }),
  z.object({ kind: z.literal("gone"), why: z.string() }),
]) satisfies z.ZodType<ImagesAnswer>;

export const LogsAnswer = z.object({ log: nstr });
export const NamesAnswer = z.object({ names: z.array(z.string()) });

const BuildResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    image: z.string(),
    bakedImage: z.string(),
    sizeBytes: z.number().nullable(),
    toolchains: z.record(z.string(), z.string()),
    log: z.string(),
    warm: z.boolean().optional(),
  }),
  z.object({
    ok: z.literal(false),
    kind: z.enum(["failed", "timeout", "refused"]),
    message: z.string(),
    logTail: z.string(),
    log: z.string(),
  }),
]) satisfies z.ZodType<BuildResult>;

export const BuildAnswer = BuildResultSchema;
export const AdoptAnswer = z.union([
  z.object({ kind: z.literal("settled"), result: BuildResultSchema }),
  z.object({ kind: z.literal("gone") }),
  z.object({ kind: z.literal("unknown"), why: z.string() }),
]) satisfies z.ZodType<AdoptResult>;
export const RemovedAnswer = z.object({ removed: z.boolean() });

export const PrefetchAnswer = z.object({
  images: z.array(z.object({
    name: z.enum([
      "agent",
      "run-gate",
      "browser",
      "tool-guard",
      "harness",
      "universal",
      "buildkit",
    ]),
    image: z.string(),
    state: z.enum(["present", "pulling", "queued", "failed"]),
    error: nstr,
  })),
}) satisfies z.ZodType<{ images: PrefetchImage[] }>;

export const ListingAnswer = z.object({ listing: z.string().min(1) });
export const ReclaimedAnswer = z.object({ containers: z.number(), networks: z.number() });

/**
 * What the launcher says of itself (GET /v1/info): the engine as it reads it now, and the parts
 * of its configuration a caller has to know to say true things about runs — whether they are
 * confined, and what the gate they dial is called. Nothing here is a knob the caller turns.
 */
export const InfoAnswer = z.object({
  /** `LAUNCHER_WIRE_REVISION`, as the launcher speaks it. */
  wire: z.number().int(),
  /** Null: docker did not answer just now. */
  engine: z.object({
    version: z.string(),
    vm: z.boolean(),
    isolatedGateway: z.boolean(),
    podman: z.boolean(),
  }).nullable(),
  network: nstr,
  runNetwork: nstr,
  /** The run gate's container name — the host a confined run dials — or null when unconfined. */
  gate: nstr,
  /**
   * What the gate relays, each listen port to its target, or null when unconfined. A caller
   * compares the addresses it hands runs against these (a port the gate does not relay is a run
   * that cannot call home), and the binary reads from them whether the gate dials it over a
   * network rather than at the host (its listeners must then leave loopback).
   */
  routes: z.array(z.object({ listen: z.number(), target: z.string(), port: z.number() }))
    .nullable(),
  runtime: nstr,
  /** Which of the optional ports this launcher serves. */
  checks: z.boolean(),
  builds: z.boolean(),
  /** Why this launcher refuses every build it is asked for, or null when it builds some. */
  buildsRefused: nstr,
  prefetch: z.boolean(),
});
export type LauncherInfo = z.infer<typeof InfoAnswer>;

/** One line of a long call's answer. */
export const LongLine = z.union([
  z.object({ beat: z.literal(1) }),
  z.object({ result: z.unknown() }),
  z.object({ error: z.string(), message: z.string() }),
]);

/** A refusal or failure answered without a stream: `{error, message}`. */
export const ErrorAnswer = z.object({ error: z.string(), message: z.string().optional() });
