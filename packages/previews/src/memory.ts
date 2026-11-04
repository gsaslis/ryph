// What keeps a previews pod inside its memory: its real memory, sampled about once a second, not
// an estimate of what each stream might hold. Every estimate missed something an agent's dev
// server or a viewer's page could make the pod hold — request bodies read while they wait, idle
// load-balancer connections, the garbage collector's slack, sends stuck on a tunnel — and an OOM
// kill drops every run's previews on the pod, not the one that caused it.
//
// Where it reads: the pod's cgroup (v2 `memory.current` against `memory.max`, else v1's
// `memory.usage_in_bytes` against `memory.limit_in_bytes`), less the inactive file cache
// (`memory.stat`), as the kubelet's working set is. That is conservative against the OOM killer,
// which also reclaims active file cache before it kills anything. On cgroup v2 the usage includes
// the kernel's TCP socket buffers; v1 counts those apart (`memory.kmem.tcp.*`), and they are not
// read here. The limit is read once, at start: a pod's limit does not change under it. Without a
// cgroup limit (a laptop, compose without `mem_limit`) the process's RSS against a limit it is
// given (RYPH_PREVIEWS_MEMORY_LIMIT_MIB); without either there is nothing to guard against.
//
// Levels, as fractions of the limit, each left only HYSTERESIS below where it is entered, so a pod
// near a watermark does not flap: HIGH (0.75), where the service refuses the groups it names as
// culprits and nobody else, and CRITICAL (0.9), where it refuses everyone and closes streams
// (service.ts says how). Below HIGH, nothing. How long it has been CRITICAL (`criticalSince`) is
// the service's to act on; reads that keep failing while raised return it to normal after
// UNREADABLE_SAMPLES. What the pod held before it was pressed (`baseline`, the least of its normal
// samples over BASELINE_MS, and never more than 2 × HYSTERESIS below HIGH) is what the service
// measures growth against when it names culprits.
import { readFileSync } from "node:fs";
import type { Pressure } from "@ryph/tunnel";

/** The defaults: refuse the culprits at 3/4 of the limit, everyone at 9/10. */
export const HIGH = 0.75;
export const CRITICAL = 0.9;
/** A level is left only once usage is this far (a fraction of the limit) below where it is
 * entered: HIGH below 0.70, CRITICAL below 0.85 by default. */
export const HYSTERESIS = 0.05;
/** How often memory is sampled. */
export const SAMPLE_MS = 1_000;
/** A full garbage collection runs at most this often, and only past HIGH. Nothing is sampled again
 * after it: what it frees reaches the cgroup's counter seconds later (measured 3–15 s), so the
 * samples that follow see it. */
export const GC_EVERY_MS = 10_000;
/** Failed reads in a row, while raised, after which the guard says normal again: refusing on a
 * reading it no longer has would refuse forever. */
export const UNREADABLE_SAMPLES = 3;
/** How far back the baseline looks over the samples taken at normal: the least of them is what
 * the pod held before anything pressed it. Long enough that a page load's peak is not it, short
 * enough that a pod that has grown honestly (more runs) is measured against what it holds now. */
export const BASELINE_MS = 5 * 60_000;

/** Why `high` and `critical` cannot be a guard's watermarks, or null when they can. */
export function badWatermarks(high: number, critical: number): string | null {
  return high > HYSTERESIS && high < critical && critical <= 1
    ? null
    : `memory watermarks must be ${HYSTERESIS} < high < critical <= 1, got ${high} and ${critical}`;
}

/** One sample: bytes in use, of `limit`. */
export interface MemoryReading {
  used: number;
  limit: number;
}

/** Where the memory is read: a cgroup's counters, or the process's RSS. */
export interface MemorySource {
  kind: "cgroup2" | "cgroup1" | "rss";
  /** The limit in bytes. */
  limit: number;
  /** Bytes in use now. Throws when it cannot be read. */
  used(): number;
}

/** Reads a small file whole, or null when it is not there. */
export type ReadFile = (path: string) => string | null;

const readFile: ReadFile = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** cgroup v1 writes its "no limit" as the largest page-aligned 63-bit number; anything near it is
 * no limit. */
const UNLIMITED = 2 ** 60;

/** `key`'s value in a `memory.stat`, or 0 when it has none. */
export function statValue(stat: string | null, key: string): number {
  const line = stat?.split("\n").find((one) => one.startsWith(`${key} `));
  const value = Number(line?.slice(key.length + 1).trim());
  return Number.isFinite(value) ? value : 0;
}

function bytes(text: string | null): number | null {
  const value = Number(text?.trim());
  return text === null || !Number.isFinite(value) || value <= 0 ? null : value;
}

/**
 * Where this process's memory can be read and against what limit: cgroup v2, then v1, then the
 * RSS against `limitBytes`; null when nothing gives a limit. `read`, `rss` and `root` are seams
 * for tests.
 */
export function memorySource(opts: {
  limitBytes?: number;
  read?: ReadFile;
  rss?: () => number;
  root?: string;
} = {}): MemorySource | null {
  const read = opts.read ?? readFile;
  const root = opts.root ?? "/sys/fs/cgroup";
  const must = (path: string) => {
    const text = read(path);
    if (text === null) throw new Error(`cannot read ${path}`);
    return text;
  };
  // v2: one file for the limit, "max" when there is none.
  const max = read(`${root}/memory.max`);
  if (max !== null) {
    const limit = max.trim() === "max" ? null : bytes(max);
    if (limit !== null) {
      return {
        kind: "cgroup2",
        limit,
        used: () =>
          Math.max(
            0,
            Number(must(`${root}/memory.current`).trim()) -
              statValue(read(`${root}/memory.stat`), "inactive_file"),
          ),
      };
    }
  } else {
    const limit = bytes(read(`${root}/memory/memory.limit_in_bytes`));
    if (limit !== null && limit < UNLIMITED) {
      return {
        kind: "cgroup1",
        limit,
        used: () => {
          const stat = read(`${root}/memory/memory.stat`);
          return Math.max(
            0,
            Number(must(`${root}/memory/memory.usage_in_bytes`).trim()) -
              (statValue(stat, "total_inactive_file") || statValue(stat, "inactive_file")),
          );
        },
      };
    }
  }
  if (opts.limitBytes === undefined || !(opts.limitBytes > 0)) return null;
  const rss = opts.rss ?? (() => process.memoryUsage.rss());
  return { kind: "rss", limit: opts.limitBytes, used: rss };
}

/** The most a socket's kernel buffers may grow to each way where the pod caps them (the chart's
 * `previews.capSocketBuffers`): two of the tunnel's frames. */
export const SOCKET_BUFFER_CAP = 128 * 1024;

/**
 * The kernel's ceilings on a TCP socket's receive and send buffers (the last field of
 * `net.ipv4.tcp_rmem` and `tcp_wmem`) when either is past SOCKET_BUFFER_CAP; null when both are
 * within it, or there is nothing to read (not Linux). Past it a page that never reads can grow a
 * socket's buffers by megabytes between two samples, and more memory does not make up for that.
 */
export function uncappedSocketBuffers(
  read: ReadFile = readFile,
): { rmem: number; wmem: number } | null {
  const max = (name: string) => {
    const fields = read(`/proc/sys/net/ipv4/${name}`)?.trim().split(/\s+/);
    const value = Number(fields?.at(-1));
    return fields === undefined || !Number.isFinite(value) ? null : value;
  };
  const rmem = max("tcp_rmem");
  const wmem = max("tcp_wmem");
  if (rmem === null || wmem === null) return null;
  return rmem > SOCKET_BUFFER_CAP || wmem > SOCKET_BUFFER_CAP ? { rmem, wmem } : null;
}

/** Bun's own full collection, where there is one. */
function bunGc(): (() => void) | null {
  const bun = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun;
  return typeof bun?.gc === "function" ? () => bun.gc!(true) : null;
}

export interface GuardOptions {
  source: MemorySource;
  /** Fraction of the limit at which it is HIGH. Default HIGH. */
  high?: number;
  /** Fraction of the limit at which it is CRITICAL. Default CRITICAL. */
  critical?: number;
  /** Called after every sample at HIGH or above, to shed: about once a second while it lasts. */
  pressed?: (level: Exclude<Pressure, "normal">, reading: MemoryReading) => void;
  /** Called when the level changes. */
  changed?: (level: Pressure, previous: Pressure, reading: MemoryReading | null) => void;
  /** Called after every sample it could read, whatever the level, once the level is set. */
  sampled?: (level: Pressure, reading: MemoryReading) => void;
  /** Called when a sample cannot be read; the level stays as it was, until UNREADABLE_SAMPLES in
   * a row while raised, which return it to normal. */
  unreadable?: (error: unknown, inARow: number) => void;
  /** Called when a timed sample throws (one of the callbacks above did): the timer keeps going,
   * since a pod whose guard died with it would go down in the incident it guards against. */
  failed?: (error: unknown) => void;
  /** A full collection. Default Bun's, where there is one; null for none. */
  gc?: (() => void) | null;
  /** Seam for tests. */
  now?: () => number;
}

export class MemoryGuard {
  readonly source: MemorySource;
  /** Bytes at which it is HIGH, and below which it leaves HIGH. */
  readonly highBytes: number;
  readonly highExitBytes: number;
  /** Bytes at which it is CRITICAL, and below which it leaves CRITICAL. */
  readonly criticalBytes: number;
  readonly criticalExitBytes: number;
  /** The most the baseline may be: 2 × HYSTERESIS below HIGH. */
  readonly baselineCapBytes: number;
  #level: Pressure = "normal";
  #last: MemoryReading | null = null;
  #criticalSince: number | null = null;
  #unreadable = 0;
  #lastGc = -Infinity;
  // The normal samples of the last BASELINE_MS, the latest included, that are less than every
  // later one, oldest first: the first is the least.
  #lows: { at: number; used: number }[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #opts: GuardOptions;
  readonly #gc: (() => void) | null;
  readonly #now: () => number;

  constructor(opts: GuardOptions) {
    const high = opts.high ?? HIGH;
    const critical = opts.critical ?? CRITICAL;
    const bad = badWatermarks(high, critical);
    if (bad !== null) throw new RangeError(bad);
    this.source = opts.source;
    this.highBytes = Math.floor(opts.source.limit * high);
    this.highExitBytes = Math.floor(opts.source.limit * (high - HYSTERESIS));
    this.criticalBytes = Math.floor(opts.source.limit * critical);
    this.criticalExitBytes = Math.floor(opts.source.limit * Math.max(high, critical - HYSTERESIS));
    this.baselineCapBytes = Math.floor(opts.source.limit * Math.max(0, high - 2 * HYSTERESIS));
    this.#opts = opts;
    this.#gc = opts.gc === undefined ? bunGc() : opts.gc;
    this.#now = opts.now ?? Date.now;
  }

  /** Where it stood at the last sample. */
  get level(): Pressure {
    return this.#level;
  }

  /** The last sample, or null before the first. */
  get last(): MemoryReading | null {
    return this.#last;
  }

  /**
   * The least it held at normal over the last BASELINE_MS of normal samples: what the pod held
   * before it was pressed, held as it was while it stays raised. Never more than
   * `baselineCapBytes`, 2 × HYSTERESIS below HIGH: a pod held just under the watermark for
   * minutes (by memory no run's bytes say, or by growth too slow to notice) must not make a
   * small spike past it all the growth there is to explain. Null before the first normal sample
   * (a pod that starts pressed has none).
   */
  get baseline(): number | null {
    const least = this.#lows[0]?.used;
    return least === undefined ? null : Math.min(least, this.baselineCapBytes);
  }

  /** Since when it has been CRITICAL without a break; null below it. */
  get criticalSince(): number | null {
    return this.#criticalSince;
  }

  /** Samples once, acts on it, and says where it stands. */
  check(): Pressure {
    const reading = this.#read();
    if (reading === null) {
      if (this.#level !== "normal" && this.#unreadable >= UNREADABLE_SAMPLES) {
        this.#set("normal", null);
      }
      return this.#level;
    }
    this.#last = reading;
    const level = this.#classify(reading.used);
    this.#set(level, reading);
    if (level === "normal") this.#low(reading.used);
    this.#opts.sampled?.(level, reading);
    if (level === "normal") return level;
    // What a collection frees shows in later samples, not this one.
    if (this.#gc !== null && this.#now() - this.#lastGc >= GC_EVERY_MS) {
      this.#lastGc = this.#now();
      this.#gc();
    }
    this.#opts.pressed?.(level, reading);
    return level;
  }

  /** Samples every SAMPLE_MS (or `everyMs`) from now on; it never keeps the process alive. */
  start(everyMs = SAMPLE_MS): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      try {
        this.check();
      } catch (error) {
        this.#opts.failed?.(error);
      }
    }, everyMs);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #set(level: Pressure, reading: MemoryReading | null) {
    const previous = this.#level;
    if (level === previous) return;
    this.#level = level;
    this.#criticalSince = level === "critical" ? this.#criticalSince ?? this.#now() : null;
    this.#opts.changed?.(level, previous, reading);
  }

  #low(used: number) {
    const at = this.#now();
    while (this.#lows.length > 0 && this.#lows.at(-1)!.used >= used) this.#lows.pop();
    this.#lows.push({ at, used });
    while (at - this.#lows[0].at > BASELINE_MS) this.#lows.shift();
  }

  #read(): MemoryReading | null {
    try {
      const reading = { used: this.source.used(), limit: this.source.limit };
      if (!Number.isFinite(reading.used)) throw new Error("memory usage is not a number");
      this.#unreadable = 0;
      return reading;
    } catch (error) {
      this.#unreadable++;
      this.#opts.unreadable?.(error, this.#unreadable);
      return null;
    }
  }

  /** The level for `used`, from where it stands now: a level is entered at its watermark and left
   * only below its exit. */
  #classify(used: number): Pressure {
    const was = this.#level;
    if (used >= this.criticalBytes || (was === "critical" && used >= this.criticalExitBytes)) {
      return "critical";
    }
    if (used >= this.highBytes || (was !== "normal" && used >= this.highExitBytes)) return "high";
    return "normal";
  }
}
