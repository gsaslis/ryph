// The proxy's in-memory spend bookkeeping: what each run has spent so far, how long it has been
// over its cap, and how many of its spending calls are open — plus one gauge for the deployment's
// window. The mcp-gateway's per-run meters, one package over, are the precedent for keeping this
// in the process rather than in a row.
//
// Invariants:
// - a run's settled spend is SEEDED from the store the first time the process sees the run and
//   then only ever added to, so a proxy restart re-reads the trail and gains the run no headroom
// - crossing a cap is noted THE MOMENT the spend that crosses it is counted — at the seed or at
//   the row — never at the next request, so a run that goes quiet after crossing has still used
//   up its grace by the time it asks again. The verdict turns to "over" only once the run has sat
//   past its cap for the backstop grace: the orchestrator is the decider and cancels within that
//   grace, and this refusal is what remains when it cannot
// - the in-flight count is taken before a call is forwarded and released however its body ends,
//   the gateway's idempotent-release closure carried over; it is the one figure a restart loses
// - the deployment gauge is re-read from the store on a fixed cadence, so a catalogue edit or a
//   row this process did not write is absorbed within a minute, and counted in memory between
//   re-reads so a burst cannot outrun it

export interface RunSpendLimits {
  spendUsd: number | null;
  callsInFlight: number | null;
}

export type LimitVerdict =
  | { kind: "ok" }
  | { kind: "over"; limit: "spend" | "deployment-spend" };

export interface SpendMeter {
  /** Whether this process has seeded the run's spend yet. */
  has(runId: string): boolean;
  /** The run's settled spend as the store knows it; the starting point for `add`. */
  seed(runId: string, spentUsd: number, spendUsd: number | null, nowMs: number): void;
  /** One more priced record, as it is recorded. */
  add(runId: string, usd: number, spendUsd: number | null, nowMs: number): void;
  /** Whether the run may spend right now. */
  verdict(runId: string, limits: RunSpendLimits, nowMs: number): LimitVerdict;
  /** One of the run's concurrency slots, or null when all are held. Releasing twice is a no-op. */
  take(runId: string, max: number | null, nowMs: number): (() => void) | null;
}

interface RunEntry {
  /** Whether the store's figure has been read in; an entry a slot or a row created is not yet. */
  seeded: boolean;
  spentUsd: number;
  /** When the run's spend first reached its cap; null while under it. */
  overSinceMs: number | null;
  inFlight: number;
  lastMs: number;
}

const DEFAULT_IDLE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_MS = 60_000;

export function makeSpendMeter(opts: {
  /** How long a run may sit over its spend cap before its calls are refused. */
  backstopMs: number;
  idleMs?: number;
  sweepMs?: number;
}): SpendMeter {
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const sweepMs = opts.sweepMs ?? DEFAULT_SWEEP_MS;
  const entries = new Map<string, RunEntry>();
  let nextSweepMs = 0;

  const sweep = (nowMs: number) => {
    if (nowMs < nextSweepMs) return;
    nextSweepMs = nowMs + sweepMs;
    for (const [id, entry] of entries) {
      if (entry.inFlight === 0 && nowMs - entry.lastMs > idleMs) entries.delete(id);
    }
  };
  const entryFor = (runId: string, nowMs: number): RunEntry => {
    sweep(nowMs);
    let entry = entries.get(runId);
    if (entry === undefined) {
      entry = { seeded: false, spentUsd: 0, overSinceMs: null, inFlight: 0, lastMs: nowMs };
      entries.set(runId, entry);
    }
    entry.lastMs = nowMs;
    return entry;
  };
  /** Starts, keeps, or clears the run's over-the-cap clock against what it has spent now. */
  const noteCrossing = (entry: RunEntry, spendUsd: number | null, nowMs: number) => {
    if (spendUsd === null || entry.spentUsd < spendUsd) entry.overSinceMs = null;
    else entry.overSinceMs ??= nowMs;
  };

  return {
    has(runId) {
      return entries.get(runId)?.seeded === true;
    },
    seed(runId, spentUsd, spendUsd, nowMs) {
      // The first seed wins: two requests that both saw an unseeded run read the store in
      // parallel, and the later figure would erase whatever the earlier request added since.
      const entry = entryFor(runId, nowMs);
      if (entry.seeded) return;
      entry.seeded = true;
      entry.spentUsd = spentUsd;
      noteCrossing(entry, spendUsd, nowMs);
    },
    add(runId, usd, spendUsd, nowMs) {
      const entry = entryFor(runId, nowMs);
      entry.spentUsd += usd;
      noteCrossing(entry, spendUsd, nowMs);
    },
    verdict(runId, limits, nowMs) {
      const entry = entryFor(runId, nowMs);
      noteCrossing(entry, limits.spendUsd, nowMs);
      if (entry.overSinceMs === null) return { kind: "ok" };
      return nowMs - entry.overSinceMs >= opts.backstopMs
        ? { kind: "over", limit: "spend" }
        : { kind: "ok" };
    },
    take(runId, max, nowMs) {
      const entry = entryFor(runId, nowMs);
      if (max !== null && entry.inFlight >= max) return null;
      entry.inFlight += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        entry.inFlight -= 1;
      };
    },
  };
}

export interface DeploymentGauge {
  /** Whether the window's figure should be re-read from the store before it is trusted. */
  stale(nowMs: number): boolean;
  seed(spentUsd: number, nowMs: number): void;
  add(usd: number): void;
  reached(): boolean;
  snapshot(): { usd: number; windowDays: number; spentUsd: number };
}

const DEFAULT_RESEED_MS = 60_000;

export function makeDeploymentGauge(opts: {
  ceilingUsd: number;
  windowDays: number;
  reseedMs?: number;
}): DeploymentGauge {
  const reseedMs = opts.reseedMs ?? DEFAULT_RESEED_MS;
  let spentUsd = 0;
  let freshUntilMs = 0;
  return {
    stale(nowMs) {
      return nowMs >= freshUntilMs;
    },
    seed(usd, nowMs) {
      // Only while stale, for the same reason a run's first seed wins: two refreshers read the
      // window in parallel, and the second figure would erase what was added since the first.
      if (nowMs < freshUntilMs) return;
      spentUsd = usd;
      freshUntilMs = nowMs + reseedMs;
    },
    add(usd) {
      spentUsd += usd;
    },
    reached() {
      return spentUsd >= opts.ceilingUsd;
    },
    snapshot() {
      return { usd: opts.ceilingUsd, windowDays: opts.windowDays, spentUsd };
    },
  };
}
