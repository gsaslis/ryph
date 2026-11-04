// What the kubernetes and docker check launchers agree on: the names of a suite's parts, how a
// size class is split between its checks, the proxy env a check container gets, and how a log is
// cut to its last bytes. Pure, and exported for the tests.

import type { CheckSpec } from "../../ports/check_launcher.ts";
import { CHECK_NAME, CHECK_RECORD_NAME as RECORD_NAME, MAX_KEEP } from "../../core/check_types.ts";
import { CHECK_FLOOR, quantityBytes, quantityCores, type RunSize } from "../../core/run_sizes.ts";
import { BAKED_ROOT, CHECK_ENV, POOL } from "./scripts.ts";

/** A member path, as the environment build names a checkout's directory: one plain segment. */
const BAKED_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The container every backend names each stage by: what `logs` takes. */
export const CLONE_CONTAINER = "clone";
export const setupContainer = (i: number): string => `setup-${i}`;
export const checkContainer = (name: string): string => `check-${name}`;

/**
 * Refuses a spec no backend should build a record from, naming what is wrong. The core writes
 * every one of these, so a failure here is a bug upstream, said loudly rather than turned into a
 * container name nobody can find.
 */
export function assertLaunchable(spec: CheckSpec): void {
  if (!RECORD_NAME.test(spec.name)) {
    throw new Error(`not a check record name: ${JSON.stringify(spec.name)}`);
  }
  if (spec.checks.length === 0) throw new Error(`check suite ${spec.suiteId} has no checks`);
  const seen = new Set<string>();
  for (const check of spec.checks) {
    if (!CHECK_NAME.test(check.name) || seen.has(check.name)) {
      throw new Error(`not a check name, or a repeated one: ${JSON.stringify(check.name)}`);
    }
    seen.add(check.name);
    if (!Number.isInteger(check.timeoutSeconds) || check.timeoutSeconds <= 0) {
      throw new Error(`check ${check.name} has no whole-second timeout`);
    }
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(spec.clone.commit)) {
    throw new Error(`not a commit id: ${JSON.stringify(spec.clone.commit)}`);
  }
  if (spec.bakedCheckout !== null && !BAKED_PATH.test(spec.bakedCheckout)) {
    throw new Error(`not a baked checkout's path: ${JSON.stringify(spec.bakedCheckout)}`);
  }
  // The parser's rules (helpers/checks.ts `parseKeep`), held again where they become env values.
  if (spec.keep.length > MAX_KEEP) throw new Error(`${spec.keep.length} keep patterns`);
  for (const pattern of spec.keep) {
    // oxlint-disable-next-line no-control-regex
    if (pattern.trim() === "" || /[\u0000-\u001f]/.test(pattern)) {
      throw new Error(`not a keep pattern: ${JSON.stringify(pattern)}`);
    }
  }
}

/** The baked checkout's absolute path in the image, or null when the image holds none. */
export function bakedTree(spec: Pick<CheckSpec, "bakedCheckout">): string | null {
  return spec.bakedCheckout === null ? null : `${BAKED_ROOT}/${spec.bakedCheckout}`;
}

export function formatMebibytes(bytes: number): string {
  const mi = Math.floor(Math.max(0, bytes) / 2 ** 20);
  return mi % 1024 === 0 && mi > 0 ? `${mi / 1024}Gi` : `${mi}Mi`;
}

/**
 * One check's share of the suite's size class: its cpu and memory divided N ways, and the disk
 * the services leave divided N ways. The share is what a check is GUARANTEED: the checks share
 * the suite's cpu and memory as one pool, and when the memory runs short the check furthest over
 * its share is the one stopped (sh/pool.sh). Kubernetes asks for and limits each
 * check to its share: under gVisor a container's own limit is not enforced, so a check borrows
 * above it while the limits' sum caps the pod at the class; under runc the kernel holds each
 * check to its share. Docker limits each check's memory to its share too, as it cannot cap their
 * sum, and lets each use all of the suite's cpus.
 * Disk is split, and held, per check.
 *
 * `reservedBytes` is taken off the disk before the split — on kubernetes, what each service
 * sidecar asks for (SERVICE_EPHEMERAL_STORAGE in core/run_sizes.ts). Throws below CHECK_FLOOR,
 * naming the class, rather than launching checks that would be killed for their size.
 */
export function checkShare(
  size: RunSize,
  checks: number,
  reservedBytes = 0,
): { cpu: string | null; memory: string | null; ephemeralStorage: string | null } {
  const floor = quantityBytes(CHECK_FLOOR);
  const split = (what: string, total: number): string => {
    const each = Math.floor(total / checks);
    if (each < floor) {
      throw new Error(
        `size class "${size.name}" gives a check suite ${what}=${formatMebibytes(total)}, which ` +
          `is ${formatMebibytes(each)} for each of its ${checks} checks — under the ` +
          `${CHECK_FLOOR} a check needs. Use a larger class (RYPH_CHECKS_SIZE), or fewer checks.`,
      );
    }
    return formatMebibytes(each);
  };
  return {
    cpu: size.cpu === null
      ? null
      : `${Math.max(1, Math.floor((quantityCores(size.cpu) * 1000) / checks))}m`,
    memory: size.memory === null ? null : split("memory", quantityBytes(size.memory)),
    ephemeralStorage: size.ephemeralStorage === null
      ? null
      : split("ephemeral-storage", quantityBytes(size.ephemeralStorage) - reservedBytes),
  };
}

/**
 * The proxy env as setup and check containers get it: the spec's, with every service name added
 * to NO_PROXY. A check dials its database by name, and an HTTP client that honours HTTP_PROXY
 * would otherwise send `http://minio:9000` to the egress proxy, which has never heard of it.
 * Services on docker are on a network of their own and on kubernetes on the pod's loopback; the
 * proxy reaches neither.
 */
export function checkProxyEnv(
  proxyEnv: Record<string, string>,
  serviceNames: string[],
): Record<string, string> {
  const env = { ...proxyEnv };
  if (serviceNames.length === 0 || Object.keys(env).length === 0) return env;
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const current = (env[key] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
    env[key] = [...new Set([...current, ...serviceNames])].join(",");
  }
  return env;
}

/** `name:port` of every service, as a check's entrypoint waits on them. */
export function servicesValue(spec: Pick<CheckSpec, "services">): string {
  return spec.services.map((s) => `${s.name}:${s.port}`).join(" ");
}

/** The suite's memory pool and each check's share of it, in bytes; null when nothing sizes the
 * suite's memory, and nothing is watched. */
export interface MemoryPool {
  bytes: number;
  shareBytes: number;
}

/**
 * The reason a check the pool watcher stopped (exit CHECK_POOL_EXIT) fails with: its own failure,
 * in the numbers the launcher set. What it used is the watcher's to say, in its log's last line;
 * the launcher reads nothing the pod says about itself.
 */
export function poolStopReason(pool: MemoryPool | null): string {
  const numbers = pool === null
    ? ""
    : ` (${formatMebibytes(pool.shareBytes)} of the suite's ${formatMebibytes(pool.bytes)})`;
  return `was stopped when the suite ran short of memory, as the check furthest over its ` +
    `share${numbers}; its log says what it used`;
}

/**
 * The env one check's container reads its command from — values, never script text. With a baked
 * checkout, also where it is, the head to move it to, what of its ignored files to keep, and
 * every setup step, which then runs in the check's own container (scripts.ts `bakedCheckScript`).
 * With a memory pool, its size, this check's share, every check's name and where the pool's
 * per-check directories are mounted (sh/pool.sh).
 */
export function checkEnv(
  check: CheckSpec["checks"][number],
  spec: CheckSpec,
  pool: MemoryPool | null,
): Record<string, string> {
  const baked = bakedTree(spec);
  return {
    [CHECK_ENV.run]: check.run,
    [CHECK_ENV.timeout]: String(check.timeoutSeconds),
    [CHECK_ENV.name]: check.name,
    ...(pool === null ? {} : {
      [CHECK_ENV.pool]: POOL,
      // Every check of the suite: the only names a watcher reads in the pool directory.
      [CHECK_ENV.names]: spec.checks.map((c) => c.name).join(" "),
      [CHECK_ENV.poolBytes]: String(pool.bytes),
      [CHECK_ENV.shareBytes]: String(pool.shareBytes),
    }),
    ...(spec.services.length > 0 ? { [CHECK_ENV.services]: servicesValue(spec) } : {}),
    ...(baked === null ? {} : {
      [CHECK_ENV.baked]: baked,
      [CHECK_ENV.head]: spec.clone.commit,
      [CHECK_ENV.setupCount]: String(spec.setup.length),
      ...Object.fromEntries(spec.setup.map((step, i) => [`${CHECK_ENV.setupStep}${i}`, step.run])),
      [CHECK_ENV.keepCount]: String(spec.keep.length),
      ...Object.fromEntries(spec.keep.map((pattern, i) => [`${CHECK_ENV.keep}${i}`, pattern])),
    }),
  };
}

/** The env one setup step's container reads its command, and its mark's name, from. */
export function setupEnv(step: CheckSpec["setup"][number], index: number) {
  return { [CHECK_ENV.step]: step.run, [CHECK_ENV.stepIndex]: String(index) };
}

/** The env the clone reads its target from; the credential (`spec.clone.env`) rides separately. */
export function cloneEnv(spec: CheckSpec): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: "0",
    // An image with git-lfs installed would otherwise fetch every LFS object through the gateway,
    // which serves git and nothing else, and fail the checkout on the first one. A check that
    // needs the objects fetches them itself.
    GIT_LFS_SKIP_SMUDGE: "1",
    [CHECK_ENV.url]: spec.clone.url,
    [CHECK_ENV.head]: spec.clone.commit,
    [CHECK_ENV.base]: spec.clone.baseCommit,
  };
}

/**
 * The last `maxBytes` of a log, starting on a line boundary when there is one to start on. A log
 * is head-authored and can be anything; the cut is by UTF-8 bytes, as the cap is stated, and a
 * character split by it becomes the replacement character rather than a throw.
 */
export function lastBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  const tail = new TextDecoder().decode(bytes.subarray(bytes.length - maxBytes));
  const newline = tail.indexOf("\n");
  return newline === -1 || newline === tail.length - 1 ? tail : tail.slice(newline + 1);
}

/**
 * How many lines a log read asks the backend for. Well past any cap a caller sets in bytes; the
 * bytes are what `lastBytes` cuts to.
 */
export const LOG_TAIL_LINES = 200_000;

/**
 * A backend's timestamp as the port reports it: whole seconds, UTC (`2026-09-30T12:00:00Z`), which
 * is what a forge takes. Docker reports nanoseconds and "never" as year 1; both, and anything that
 * does not parse, come back as the port's null or cut to the second.
 */
export function timestamp(value: string | null | undefined): string | null {
  if (!value || value.startsWith("0001-01-01")) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}
