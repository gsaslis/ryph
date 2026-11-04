// One process at a time: a lease that one replica holds and the others wait for, for work that
// two replicas must never do at once. The MCP gateway's hosting (mcp-gateway's core/lease.ts says
// why) and the control plane's reserved capacity (orchestrator's core/reserved_capacity.ts) each
// take one; a rolling update or an eviction is where two replicas overlap.
//
// THE RULES — client-go's leader election, with the parts this needs:
// - a holder renews every `retryMs`. One that has not managed to for `renewDeadlineMs` stops
//   calling itself the holder, and does so BEFORE anyone else may take over, because `durationMs`
//   is longer: the gap between the two is the margin a slow request has to land in.
// - a lease held by someone else is free once it has not CHANGED for `durationMs` by THIS
//   process's clock. Its `renewedAt` is the other process's clock and is never compared with ours,
//   so two pods whose clocks disagree cannot both believe they hold it.
// - every interval is timed on a MONOTONIC clock, never the wall clock: an NTP step on either side
//   (after a VM pause or a live migration) would otherwise move a holder's deadline or a taker's
//   count by the size of the step, as client-go avoids too. The wall clock only stamps
//   `renewedAt`. That duration counts from when a version was SEEN — the read's answer, not its
//   request: the version may have been written at any moment until the answer arrived, and a slow
//   read must not backdate it.
// - a released lease (no holder) is free at once. A clean shutdown releases once it has stopped
//   acting, so the successor starts then rather than a lease duration later.
// - every write is conditioned on the version just read, so two takers cannot both win.
//
// What a lease cannot do is fence the API server: a request the old holder sent just before its
// deadline can still land after the new holder's first. The margin makes that unlikely rather than
// impossible, so a caller whose stray late write would hurt guards that write some other way too
// (the gateway's Kubernetes tool host deletes by uid).
//
// Pure given its port: the store, the clocks and the sleep are injected, so every rule above is a
// test against an in-memory lease and a clock that moves only when the test moves it.

import type { LeaseRecord, LeaseStore, VersionedLease } from "./lease_store.ts";

/** A lease as the process taking it sees it. */
export interface LeaseHolder {
  /** Who this process is in the lease, for logs. */
  readonly identity: string;
  /**
   * Whether this process may act as the holder right now. It lapses by itself: false once
   * renewals have failed for the renew deadline, whether or not anything has noticed yet.
   */
  held(): boolean;
  /** Resolves once this process holds the lease. Rejects only when `signal` aborts. */
  acquire(signal: AbortSignal): Promise<void>;
  /** Renews until the lease is lost (`lost`) or `signal` aborts (`stopped`). */
  keep(signal: AbortSignal): Promise<"lost" | "stopped">;
  /** Gives it up, so a successor need not wait out its duration. Best effort; never throws. */
  release(): Promise<void>;
}

export interface LeaseTimings {
  /** How long a lease that stops changing stays taken. */
  durationMs: number;
  /** How long a holder goes without a renewal before it stops acting as one. */
  renewDeadlineMs: number;
  /** How often a holder renews, and a waiter looks again. */
  retryMs: number;
}

/** client-go's defaults: a crashed holder's successor waits at most fifteen seconds. */
export const DEFAULT_LEASE_TIMINGS: LeaseTimings = {
  durationMs: 15_000,
  renewDeadlineMs: 10_000,
  retryMs: 2_000,
};

export interface LeaseDeps {
  store: LeaseStore;
  /**
   * Unique per PROCESS, not per pod: a container the kubelet restarts must not believe it still
   * holds the lease its previous run held.
   */
  identity: string;
  /** The wall clock: only for the `renewedAt` an operator reads, never for timing. */
  now(): Date;
  /**
   * The clock every interval is timed on, in ms. Monotonic; defaults to `performance.now()`.
   * Injectable so tests move it by hand.
   */
  monotonicMs?: () => number;
  /** Resolves after `ms`, or as soon as `signal` aborts. Injectable so tests do not sleep. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  diag: {
    debug(event: string, data?: Record<string, unknown>): void;
    warn(event: string, data?: Record<string, unknown>): void;
  };
  timings?: Partial<LeaseTimings>;
}

/**
 * A LeaseHolder plus the one step its loops repeat: exposed so a test can take it by hand, and so
 * a caller that already runs on a tick of its own can drive the lease from it instead of `keep`.
 */
export interface Lease extends LeaseHolder {
  tick(): Promise<void>;
}

function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function makeLease(deps: LeaseDeps): Lease {
  const t: LeaseTimings = { ...DEFAULT_LEASE_TIMINGS, ...deps.timings };
  if (!(t.retryMs < t.renewDeadlineMs && t.renewDeadlineMs < t.durationMs)) {
    throw new Error(
      `lease timings need retry < renew deadline < duration, got ${t.retryMs} / ` +
        `${t.renewDeadlineMs} / ${t.durationMs} ms — without that order a holder can still be ` +
        "acting when someone else takes over",
    );
  }
  const { store, identity, diag } = deps;
  const sleep = deps.sleep ?? sleepFor;
  const nowMs = deps.monotonicMs ?? (() => performance.now());

  /** The lease as this process last wrote it while holding; null while not holding. */
  let mine: VersionedLease | null = null;
  /** When this process last took or renewed it — the START of that attempt, by our clock. */
  let renewedAt = 0;
  /** Someone else's lease as last read, and since when it has looked like that, by our clock. */
  let seen: { version: string; holder: string | null; since: number } | null = null;
  /** Set by `release`: nothing is taken or renewed after it. */
  let released = false;
  let inFlight: Promise<void> = Promise.resolve();

  const held = () => mine !== null && nowMs() - renewedAt < t.renewDeadlineMs;

  const record = (holder: string | null, transitions: number): LeaseRecord => ({
    holder,
    durationMs: t.durationMs,
    renewedAt: deps.now().toISOString(),
    transitions,
  });

  const take = (lease: VersionedLease, at: number, how: string) => {
    mine = lease;
    renewedAt = at;
    seen = null;
    diag.debug("lease.acquired", { identity, how, transitions: lease.record.transitions });
  };

  const lose = (why: string) => {
    if (mine === null) return;
    mine = null;
    diag.warn("lease.lost", { identity, why });
  };

  const attempt = async (): Promise<void> => {
    // What a success counts from is when the attempt STARTED: a write that took five seconds to
    // answer must not buy its holder five seconds more.
    const at = nowMs();
    if (mine !== null) {
      const renewed = await store.replace(record(identity, mine.record.transitions), mine.version);
      if (renewed !== null) {
        mine = renewed;
        renewedAt = at;
        return;
      }
      // The version moved. Our own last write can do that — it landed and its answer was lost —
      // so read before concluding anyone took it, and then claim it with a write guarded on the
      // version just read: someone may replace it between our read and anything we do with it.
      const current = await store.read();
      if (current !== null && current.record.holder === identity) {
        const reconfirmed = await store.replace(
          record(identity, current.record.transitions),
          current.version,
        );
        if (reconfirmed !== null) {
          mine = reconfirmed;
          renewedAt = at;
          return;
        }
      }
      lose(`${current?.record.holder ?? "nobody"} holds it now`);
      seen = current === null
        ? null
        : { version: current.version, holder: current.record.holder, since: nowMs() };
      return;
    }

    const current = await store.read();
    // When this version was seen. The attempt's start is right for what WE write (renewedAt) and
    // wrong for what we read: counting someone else's lease from before the read answered would
    // let a slow GET hand us a lease its holder renewed while that GET was in flight.
    const seenAt = nowMs();
    if (current === null) {
      const created = await store.create(record(identity, 0));
      if (created !== null) take(created, at, "created");
      return;
    }
    if (current.record.holder === identity) {
      // A take of ours that landed with its answer lost. The read alone proves nothing now: a
      // taker that has seen that version still for its duration may replace it the moment after,
      // so it is ours only once a write guarded on this version lands.
      const reconfirmed = await store.replace(
        record(identity, current.record.transitions),
        current.version,
      );
      if (reconfirmed !== null) take(reconfirmed, at, "recovered");
      return;
    }
    if (seen === null || seen.version !== current.version) {
      if (current.record.holder !== null && seen?.holder !== current.record.holder) {
        diag.debug("lease.waiting", { identity, holder: current.record.holder });
      }
      seen = { version: current.version, holder: current.record.holder, since: seenAt };
    }
    const free = current.record.holder === null ||
      seenAt - seen.since >= current.record.durationMs;
    if (!free) return;
    const taken = await store.replace(
      record(identity, current.record.transitions + 1),
      current.version,
    );
    if (taken !== null) take(taken, at, current.record.holder === null ? "released" : "expired");
  };

  /** One read-and-act, serialized and never throwing: a failure is a renewal that did not happen. */
  const tick = (): Promise<void> => {
    const next = inFlight.then(async () => {
      if (released) return;
      try {
        await attempt();
      } catch (err) {
        diag.debug("lease.attempt_failed", { identity, err: describe(err) });
      }
    });
    inFlight = next;
    return next;
  };

  /**
   * A tick, waited on only until `deadline` (our clock) or `signal`. A renewal whose request hangs
   * must not hold up the loop that reports the loss: `held()` lapses at the renew deadline whatever
   * the request is doing, and the drain has to start then, not whenever the request answers.
   * The tick itself stays in flight; the store's own request timeout is what ends it.
   */
  const tickUntil = async (deadline: number, signal: AbortSignal): Promise<void> => {
    const done = new AbortController();
    const stop = () => done.abort();
    signal.addEventListener("abort", stop, { once: true });
    try {
      await Promise.race([tick(), sleep(Math.max(0, deadline - nowMs()), done.signal)]);
    } finally {
      done.abort();
      signal.removeEventListener("abort", stop);
    }
  };

  return {
    identity,
    held,
    tick,

    async acquire(signal) {
      for (;;) {
        signal.throwIfAborted();
        if (released) {
          throw new Error("this lease was released, and a released lease is not retaken");
        }
        await tick();
        if (held()) return;
        await sleep(t.retryMs, signal);
      }
    },

    async keep(signal) {
      for (;;) {
        if (signal.aborted || released) return "stopped";
        if (!held()) {
          lose(`no renewal for ${t.renewDeadlineMs / 1000} s`);
          return "lost";
        }
        await sleep(t.retryMs, signal);
        if (signal.aborted || released) return "stopped";
        await tickUntil(renewedAt + t.renewDeadlineMs, signal);
      }
    },

    async release() {
      if (released) return;
      released = true;
      // After any attempt in flight, so a renewal landing late cannot move the version under us.
      await inFlight;
      const lease = mine;
      mine = null;
      if (lease === null) return;
      try {
        const cleared = await store.replace(record(null, lease.record.transitions), lease.version);
        diag.debug("lease.released", { identity, cleared: cleared !== null });
      } catch (err) {
        diag.debug("lease.release_failed", { identity, err: describe(err) });
      }
    },
  };
}
