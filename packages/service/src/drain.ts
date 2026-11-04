// Graceful shutdown with a deadline — the other half of what a container platform needs from a
// service, and the half that is easy to get subtly wrong.
//
// `serve`'s `shutdown()` (serve.ts) stops accepting and waits for in-flight requests to finish. That is
// the right behaviour and, on its own, a hang: a Server-Sent Events tail never finishes, so a
// replica with one open transcript stream waits forever, the platform eventually SIGKILLs it,
// and every OTHER in-flight request dies with it. The deadline here is what turns that into a
// bounded, orderly stop.
//
// The order matters as much as the deadline:
//   1. go UNREADY immediately, so the load balancer stops sending new work
//   2. optionally pause (`preStopMs`) while it notices — deregistration is not instant, and
//      requests routed during that window would land on a closing listener
//   3. close the listeners, waiting for in-flight work up to the deadline
//   4. release what the process holds (timers, database connections)
//   5. exit
//
// A SECOND signal skips the waiting, not the closing. Someone pressing ^C twice, or a platform
// escalating, has given up on in-flight requests — but step 4 is what closes the database
// cleanly, and a PGlite directory left half-written is the one thing a local user cannot
// re-create. So the second signal goes straight to step 4, bounded by `closeDeadlineMs`, and only
// a THIRD exits on the spot.
//
// One step may come before all of that: `beforeDrain`, for a process with a person in front of it
// who should be asked something while it is still whole (`ryph up`: cancel the runs still
// going?). There the first extra signal means "stop asking" and the drain goes ahead; the next
// skips its waiting, and the one after that exits.

import type { StreamTracker } from "./streams.ts";

export interface Drainable {
  shutdown(): Promise<void>;
}

/** A listener with a name for the logs and, when it has one, the tracker of its streams. */
export interface Listener {
  name: string;
  server: Drainable | null | undefined;
  /** Ended once the listener stops accepting, so `shutdown()` is not held by a tail or uplink. */
  streams?: Pick<StreamTracker, "end" | "endTails" | "open" | "inFlight">;
  /**
   * How long into the deadline its work streams are ended; default 0, at once with its tails. A
   * listener whose streams include WORK rather than tails — a completion, a tool call — can let
   * that run most of the deadline first; its tails still end at once. Timed from where the
   * deadline starts, after `preStopMs`, so it is comparable to `deadlineMs`. A second signal ends
   * them at once either way.
   */
  streamsGraceMs?: number;
}

export interface DrainLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface DrainOptions {
  /**
   * Every listener this process owns. Nulls are ignored, so optional servers need no branch. A
   * named `Listener` is named in the deadline's log line, and its streams end once it stops accepting.
   */
  servers: Array<Drainable | Listener | null | undefined>;
  /**
   * Runs on the first signal, before anything goes unready, and the drain waits for it — every
   * listener still serving, which is the point: a run cancelled here reports its end over the
   * listener the drain would close. A second signal aborts `interrupted` and the drain goes ahead
   * without waiting further; a failure is logged and the drain goes ahead too. Returning
   * `"keep-running"` cancels this stop before anything changes, unless interrupted.
   */
  beforeDrain?: (
    signal: NodeJS.Signals | undefined,
    interrupted: AbortSignal,
  ) => Promise<void | "keep-running">;
  /** Flips readiness off before anything closes — normally `health.beginDrain`. */
  beginDrain?: () => void;
  /** Released after the listeners are down: interval timers, database connections, stores. */
  close?: () => Promise<void> | void;
  /**
   * How long to stay up, unready, before closing the listeners — the window a load balancer
   * needs to deregister this replica. Default 0, which is right locally and for anything behind
   * no balancer; a cloud deployment wants a few seconds.
   */
  preStopMs?: number;
  /**
   * Hard cap on waiting for in-flight work. Default 25s, deliberately under the 30s that
   * Kubernetes (`terminationGracePeriodSeconds`) defaults to — past that the platform SIGKILLs,
   * and a SIGKILL skips step 4 entirely.
   */
  deadlineMs?: number;
  /**
   * How long `close` may take once a second signal has said to stop waiting. Default 5s: enough
   * for a database to close, short enough that a third ^C is rarely needed.
   */
  closeDeadlineMs?: number;
  log: DrainLog;
  /** Which signals begin a drain. Default SIGINT and SIGTERM. */
  signals?: NodeJS.Signals[];
  /** Seams, for tests. */
  exit?: (code: number) => never;
  addSignalListener?: (signal: NodeJS.Signals, handler: () => void) => void;
}

const DEFAULT_DEADLINE_MS = 25_000;
const DEFAULT_CLOSE_DEADLINE_MS = 5_000;

/** 128 + the signal number, the shell's convention for "died on this signal". */
const FORCED_EXIT_CODE: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

const isListener = (s: Drainable | Listener): s is Listener => "server" in s && "name" in s;

/**
 * Registers the signal handlers that drain this process. Call once, after every listener exists.
 * Returns the drain itself, so a caller with a non-signal reason to stop can run the same path.
 */
export function installDrain(opts: DrainOptions): () => Promise<void> {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const closeDeadlineMs = opts.closeDeadlineMs ?? DEFAULT_CLOSE_DEADLINE_MS;
  const preStopMs = opts.preStopMs ?? 0;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const listen = opts.addSignalListener ??
    ((signal: NodeJS.Signals, handler: () => void) => void process.on(signal, handler));
  // "skipping": a second signal landed after `before`, so nothing more is waited on but `close`.
  let stage: "running" | "before" | "draining" | "skipping" = "running";
  let interrupt = new AbortController();
  const skip = new AbortController();

  const listeners: Listener[] = opts.servers
    .filter((s): s is Drainable | Listener => Boolean(s))
    .map((s, i) => isListener(s) ? s : { name: `listener ${i}`, server: s })
    .filter((l) => Boolean(l.server));

  const drain = async (signal?: NodeJS.Signals): Promise<void> => {
    if (opts.beforeDrain) {
      interrupt = new AbortController();
      stage = "before";
      try {
        const decision = await Promise.race([
          opts.beforeDrain(signal, interrupt.signal),
          aborted(interrupt.signal),
        ]);
        if (decision === "keep-running" && !interrupt.signal.aborted) {
          stage = "running";
          return;
        }
      } catch (err) {
        opts.log.warn("drain.before_failed", { err: String(err) });
      }
    }
    if (stage !== "skipping") stage = "draining";
    opts.log.info("draining", { signal: signal ?? "requested", deadlineMs });
    // First, and before any waiting: nothing new should be routed here.
    try {
      opts.beginDrain?.();
    } catch (err) {
      opts.log.warn("drain.begin_failed", { err: String(err) });
    }
    // The pause comes before anything is ended: the balancer may still route here, and a tail
    // ended now would only reconnect to this replica and be ended again.
    if (preStopMs > 0) await Promise.race([sleep(preStopMs), aborted(skip.signal)]);

    // Stop accepting first, so a tail ended below reconnects to another replica.
    const pending = new Set(listeners);
    const settled = Promise.allSettled(
      listeners.map((l) => l.server!.shutdown().finally(() => pending.delete(l))),
    );

    // Then the streams that would otherwise hold `shutdown()` to the deadline. Tails end at once;
    // a listener's graced work runs out its grace first, timed from here, where the deadline
    // starts.
    const endStreams = (l: Listener, tailsOnly = false) => {
      try {
        if (tailsOnly) l.streams?.endTails();
        else l.streams?.end();
      } catch (err) {
        opts.log.warn("drain.streams_failed", { listener: l.name, err: String(err) });
      }
    };
    for (const l of listeners) {
      if (l.streams === undefined) continue;
      if ((l.streamsGraceMs ?? 0) <= 0 || skip.signal.aborted) {
        endStreams(l);
        continue;
      }
      endStreams(l, true);
      const timer = setTimeout(() => endStreams(l), l.streamsGraceMs);
      // Neither keeps the process up nor outlives a second signal.
      timer.unref();
      skip.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        endStreams(l);
      }, { once: true });
    }

    // A sentinel rather than a rejection: the deadline expiring is an expected outcome, not an
    // error, and it must not look like one in the logs.
    const timedOut = Symbol("deadline");
    const outcome = await Promise.race([
      settled,
      sleep(deadlineMs).then(() => timedOut),
      aborted(skip.signal).then(() => timedOut),
    ]);
    if (outcome === timedOut) {
      // Exiting non-zero here would flag every deploy that had a viewer watching a transcript.
      // The log is the signal; the exit code stays clean. It names what was still open, so the
      // next slow drain says where it is slow.
      opts.log.warn(skip.signal.aborted ? "drain.wait_skipped" : "drain.deadline_exceeded", {
        deadlineMs,
        listeners: listeners.length,
        open: [...pending].map((l) => ({
          name: l.name,
          ...(l.streams ? { inFlight: l.streams.inFlight, streams: l.streams.open } : {}),
        })),
      });
    }

    // Bounded only once someone has asked to stop waiting: until then a slow close is still the
    // clean one, and the platform's own grace period is the outer bound.
    let closed = false;
    const closing = (async () => {
      try {
        await opts.close?.();
      } catch (err) {
        opts.log.warn("drain.close_failed", { err: String(err) });
      }
      closed = true;
    })();
    await Promise.race([closing, aborted(skip.signal).then(() => sleep(closeDeadlineMs))]);
    if (!closed) {
      opts.log.warn("drain.close_timed_out", { closeDeadlineMs });
      return exit(FORCED_EXIT_CODE[signal ?? "SIGTERM"] ?? 1);
    }
    opts.log.info("stopped");
    exit(0);
  };

  for (const signal of opts.signals ?? (["SIGINT", "SIGTERM"] as const)) {
    listen(signal, () => {
      if (stage === "before" && !interrupt.signal.aborted) {
        // Stop asking — but still drain.
        opts.log.info("drain.before_interrupted", { signal });
        interrupt.abort();
        return;
      }
      if (stage === "draining" || (stage === "before" && !skip.signal.aborted)) {
        // Stop waiting on in-flight work — but still close, bounded: that is what keeps the
        // database whole.
        opts.log.warn("drain.skipping_wait", { signal, closeDeadlineMs });
        stage = "skipping";
        skip.abort();
        return;
      }
      if (stage !== "running") {
        // Asked three times. Do not make them wait again.
        opts.log.warn("drain.forced", { signal });
        return exit(FORCED_EXIT_CODE[signal] ?? 1);
      }
      void drain(signal);
    });
  }

  return () => drain();
}
