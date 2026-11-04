// How fast a host acks what its runners send, and so how much of its process's time their tunnels
// may take. A runner sends a stream's next frame only once its last is acked, so holding an ack
// back slows the runner and never refuses it: backpressure. Every frame the host takes costs it
// the message (a parse, a push to the browser's socket, the ack) and its bytes; an ack is let go
// against a token bucket of its run's (shared by every tunnel of the run) and one of the process's
// (shared evenly by the runs that want more of it than there is), each charged what the frame
// cost (`ackCost`).
//
// Measured on an M-series core over a real loopback WebSocket, unpaced: a 1-byte frame and its ack
// cost the host some 9.5 µs, a 64 KiB one some 119 µs. So a unit (ACK_COST_BYTES) is a tiny frame
// or 4 KiB of a large one, and buys about the same CPU whatever frames make it up: paced, a run's
// 24k units a second took ~47% of a core as 1-byte frames and ~38% as 64 KiB ones (messages that
// arrive spread out cost more each than a burst does). A run that sends the smallest frames as
// fast as they are acked (the cheapest way to make a host work: it needs almost no viewer
// bandwidth) is held to RUN_ACK_RATE of them a second, and its bulk transfer to RUN_ACK_RATE units,
// ~95 MB/s sustained (~123 MB/s over a 64 MiB download, the burst's share of it); every run
// together to POD_ACK_RATE, ~58% of a core for two flooding runs (one run's four tunnels took ~62%
// unpaced, two saturated it). A bulk download is the same work as a bulk flood, so bounding one
// bounds the other.
//
// Work with no ack to hold back is charged after the fact: a frame whose stream went before its
// ack did (`Cancel`), and messages late for a stream already let go (`late`). Each is charged to
// its run's bucket at once, so its next acks wait it off, and owed to the process until the run is
// next served, when it is paid in the run's own turn, ahead of its next ack: never out of the
// share of runs that did no such work, and never past the process's tokens. Late messages are
// refused past RUN_ACK_BURST of debt of their own (refilled at RUN_ACK_RATE), and the tunnel with
// them: no honest runner comes near (measured, an honest churn of some 10 000 streams a second
// never took them below full), and a runner that churns streams to send them is held to its run's
// rate (before, one took ~3.5 times it, and other runs' first acks waited up to a second).
//
// What the pace does not bound: a frame's work before its ack (it holds back the next frame, not
// this one; charged, never refused, when the ack is cancelled), a stream's open and close (those
// answer the host's own opens, which browsers' requests drive and the budget caps), and the
// runner's acks of what the host sends (one per frame a browser uploads).

/** The bytes of a frame that cost the host about what one message does. */
export const ACK_COST_BYTES = 4 * 1024;

/** What acking a frame of `bytes` costs against the pace: one unit for the message, one for each
 * ACK_COST_BYTES of it. A run's tiny frames buy no more of the host's time than its bulk does. */
export function ackCost(bytes: number): number {
  return 1 + Math.floor(Math.max(0, bytes) / ACK_COST_BYTES);
}

/** Units one run's acks may spend at once, across all its tunnels: a cold page load's thousand
 * modules, each a frame or two, without waiting. */
export const RUN_ACK_BURST = 4096;
/** Units one run's acks may spend a second, across all its tunnels: 24k of the smallest frames,
 * or ~95 MB/s of full ones. */
export const RUN_ACK_RATE = 24_576;
/** Units the process's acks may spend at once, every run's together. */
export const POD_ACK_BURST = 2 * RUN_ACK_BURST;
/** Units the process's acks may spend a second, every run's together: two runs' worth. While runs
 * contend for it each gets at least an equal part of it; alone, a run has its own RUN_ACK_RATE. */
export const POD_ACK_RATE = 2 * RUN_ACK_RATE;

export interface PacerOptions {
  /** Units a run may spend a second. Default RUN_ACK_RATE. */
  runRate?: number;
  /** Units a run may spend at once, and its late messages take it into debt (`late`). Default
   * RUN_ACK_BURST. */
  runBurst?: number;
  /** Units the process may spend a second. Default POD_ACK_RATE. */
  rate?: number;
  /** Units the process may spend at once. Default POD_ACK_BURST. */
  burst?: number;
  /** Seam for tests. */
  now?: () => number;
  /** Where an error an ack's send threw from the pacer's timer is said. Default `console.error`. */
  log?: (error: unknown) => void;
}

/** Cancels an ack `pace` holds (its stream is gone), charging its run what the ack would have
 * cost: its frame was taken all the same. Nothing once it was sent or cancelled. */
export type Cancel = () => void;

interface Bucket {
  tokens: number;
  filled: number;
}

interface Waiting {
  cost: number;
  /** Null once sent or cancelled: a cancelled ack pins nothing of its stream. */
  send: (() => void) | null;
}

interface Run extends Bucket {
  /** What its late messages may still take it into (`late`): RUN_ACK_BURST at once, RUN_ACK_RATE
   * a second, refused past RUN_ACK_BURST of debt. */
  lates: Bucket;
  /** Its acks waiting, oldest first from `head`: at most one per stream, cancelled ones passed
   * over (and dropped once they are most of it). */
  queue: Waiting[];
  head: number;
  /** Of `queue`, the acks still to be sent. */
  live: number;
  /** Units it was charged for work with no ack to hold back (`charge`, `late`, a cancelled ack)
   * that the process has not been paid yet: paid from the process's tokens when the run is next
   * served, before its next ack, so never out of another run's turn. */
  owed: number;
  /** Units it spent while runs contended, against which runs are served: least first. */
  served: number;
  /** Which stretch of contention `served` counts (`Pacer.#epoch`). */
  epoch: number;
}

/** How often runs that have not paced for a while are forgotten. */
const PRUNE_MS = 1_000;
/** Cancelled acks a run's queue may hold before it is compacted, past as many as are live. */
const DEAD_SLACK = 32;
const SENT: Cancel = () => {};

export class Pacer {
  readonly runRate: number;
  readonly runBurst: number;
  readonly rate: number;
  readonly burst: number;
  readonly #now: () => number;
  readonly #pod: Bucket;
  readonly #runs = new Map<unknown, Run>();
  readonly #log: (error: unknown) => void;
  /** Runs with acks waiting, or units owed. */
  readonly #active = new Set<Run>();
  /** A millisecond of the process's tokens, the grain of its timer: what a run that would be
   * served next may take at once on credit, and how far ahead of the least served it may be and
   * still count as next. */
  readonly #credit: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the line is being served now. */
  #serving = false;
  /** Stretches of contention so far: one starts each time a run waits while none did. */
  #epoch = 0;
  /** When the timer, if any, fires. */
  #due = 0;
  #pruned: number;

  constructor(opts: PacerOptions = {}) {
    this.runRate = opts.runRate ?? RUN_ACK_RATE;
    this.runBurst = opts.runBurst ?? RUN_ACK_BURST;
    this.rate = opts.rate ?? POD_ACK_RATE;
    this.burst = opts.burst ?? POD_ACK_BURST;
    if (!(this.runRate > 0 && this.runBurst >= 1 && this.rate > 0 && this.burst >= 1)) {
      throw new RangeError("an ack pace needs a positive rate and a burst of at least one");
    }
    this.#now = opts.now ?? Date.now;
    this.#log = opts.log ?? ((error) => console.error(`ack pace: ${error}`));
    this.#credit = this.rate / 1000;
    this.#pod = { tokens: this.burst, filled: this.#now() };
    this.#pruned = this.#pod.filled;
  }

  /** Acks waiting now, every run's. */
  get waiting(): number {
    let n = 0;
    for (const run of this.#active) n += run.live;
    return n;
  }

  /** The process's tokens now, below zero in debt. */
  get tokens(): number {
    this.#refill(this.#pod, this.rate, this.burst, this.#now());
    return this.#pod.tokens;
  }

  /** Runs it remembers now. */
  get runs(): number {
    return this.#runs.size;
  }

  /**
   * Calls `send` (the ack of a frame that cost `cost`) at once when `group`'s bucket and the
   * process's have tokens and nobody waits, else once they do, the run that spent least first.
   * A cost past what a bucket holds goes into debt the bucket's refill pays off. What it returns
   * cancels the ack while it waits (its stream gone), and nothing after.
   */
  pace(group: unknown, cost: number, send: () => void): Cancel {
    const at = this.#now();
    this.#refill(this.#pod, this.rate, this.burst, at);
    // Before the lookup: the run this paces is never forgotten under it.
    if (at - this.#pruned >= PRUNE_MS) this.#prune(at);
    const run = this.#run(group, at);
    // A run with nothing waiting or owed that would be served next goes at once while it has
    // tokens: on credit of up to a millisecond of the process's tokens, which those waiting then
    // wait off. A stream with one frame in flight is not held to the timer's grain a frame.
    if (
      !this.#active.has(run) && this.#next(run) && run.tokens >= 1 &&
      this.#pod.tokens >= 1 - this.#credit
    ) {
      this.#spend(run, cost);
      send();
      return SENT;
    }
    const entry: Waiting = { cost, send };
    this.#join(run);
    run.queue.push(entry);
    run.live++;
    this.#kick(at);
    return () => this.#cancel(run, entry);
  }

  /** Charges `group` `cost` for work that has no ack to hold back (a frame taken whose ack was
   * never asked for): its next acks wait it off. */
  charge(group: unknown, cost: number): void {
    const at = this.#now();
    this.#refill(this.#pod, this.rate, this.burst, at);
    if (at - this.#pruned >= PRUNE_MS) this.#prune(at);
    this.#owe(this.#run(group, at), cost, at);
  }

  /**
   * Charges `group` `cost` for a message late for a stream already let go, as `charge` does;
   * false, and nothing charged, when its late messages would take it past RUN_ACK_BURST of debt
   * of their own (they refill at its rate). No honest runner comes near: each stream let go
   * leaves at most a frame, an ack, an end and a close behind it, a full run's 64 some 1300 units.
   * The caller breaks the tunnel.
   */
  late(group: unknown, cost: number): boolean {
    const at = this.#now();
    this.#refill(this.#pod, this.rate, this.burst, at);
    if (at - this.#pruned >= PRUNE_MS) this.#prune(at);
    const run = this.#run(group, at);
    this.#refill(run.lates, this.runRate, this.runBurst, at);
    if (run.lates.tokens - cost < -this.runBurst) return false;
    run.lates.tokens -= cost;
    this.#owe(run, cost, at);
    return true;
  }

  /** Charges `run` `cost` of work already done: its own bucket at once, so its acks wait it off,
   * and the process when the run is next served (at once when that is now, on the same credit an
   * ack would have), never out of another run's turn. */
  #owe(run: Run, cost: number, at: number) {
    run.tokens -= cost;
    run.owed += cost;
    if (!this.#active.has(run) && this.#next(run)) this.#pay(run, this.#pod.tokens + this.#credit);
    if (run.owed > 0) {
      this.#join(run);
      this.#kick(at);
    }
  }

  /** Whether `run`, with nothing waiting, would be served next: it has spent no more than a
   * millisecond of the process's tokens past the least of those that wait. Brings it level with
   * them first (`#level`). */
  #next(run: Run): boolean {
    return !this.#serving && run.served < this.#level(run) + this.#credit;
  }

  /**
   * Brings `run` level with the runs waiting, and says what the least of them has spent while
   * they contended (Infinity when none waits). A run joins no lower than that: whatever it did
   * not spend while it had nothing waiting is never banked against those that waited. Nor
   * higher, when what it spent was in an earlier stretch of contention.
   */
  #level(run: Run): number {
    let least = Infinity;
    for (const one of this.#active) least = Math.min(least, one.served);
    if (least === Infinity) return least;
    if (run.epoch !== this.#epoch) [run.served, run.epoch] = [least, this.#epoch];
    else run.served = Math.max(run.served, least);
    return least;
  }

  /** Puts `run` among those waiting. */
  #join(run: Run) {
    if (this.#active.has(run)) return;
    if (this.#active.size === 0) {
      // Runs start level each time they start to contend: what one spent while nobody else
      // wanted the tokens is not held against it.
      this.#epoch++;
      run.epoch = this.#epoch;
      run.served = 0;
    } else this.#level(run);
    this.#active.add(run);
  }

  /** Serves the line now when the process has a token, else once it will. An ack sent while the
   * line is served (its send paced another) waits for that loop. */
  #kick(at: number) {
    if (this.#serving) return;
    if (this.#pod.tokens >= 1) this.serve();
    else this.#schedule(at);
  }

  #cancel(run: Run, entry: Waiting) {
    if (entry.send === null) return;
    entry.send = null;
    run.live--;
    if (run.live === 0 && run.owed === 0) this.#leave(run);
    else if (run.queue.length - run.head - run.live > Math.max(DEAD_SLACK, run.live)) {
      // Mostly cancelled: dropped in one pass, each paid for by the cancel that made it.
      run.queue = run.queue.slice(run.head).filter((one) => one.send !== null);
      run.head = 0;
    }
    const at = this.#now();
    this.#refill(this.#pod, this.rate, this.burst, at);
    this.#refill(run, this.runRate, this.runBurst, at);
    this.#owe(run, entry.cost, at);
  }

  /** `run` has nothing waiting or owed. */
  #leave(run: Run) {
    run.queue = [];
    run.head = 0;
    this.#active.delete(run);
  }

  /** `group`'s buckets, refilled to `at`. */
  #run(group: unknown, at: number): Run {
    let run = this.#runs.get(group);
    if (run === undefined) {
      run = {
        tokens: this.runBurst,
        filled: at,
        lates: { tokens: this.runBurst, filled: at },
        queue: [],
        head: 0,
        live: 0,
        owed: 0,
        served: 0,
        epoch: -1,
      };
      this.#runs.set(group, run);
    }
    this.#refill(run, this.runRate, this.runBurst, at);
    return run;
  }

  #refill(bucket: Bucket, rate: number, burst: number, at: number) {
    bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, at - bucket.filled) * rate / 1000);
    // Never back: a clock stepped back (NTP, a VM resumed) would credit the step again.
    bucket.filled = Math.max(bucket.filled, at);
  }

  #spend(run: Run, cost: number) {
    run.tokens -= cost;
    run.served += cost;
    this.#pod.tokens -= cost;
  }

  /** Pays the process up to `most` of what `run` owes it. */
  #pay(run: Run, most: number) {
    const paid = Math.max(0, Math.min(run.owed, most));
    run.owed -= paid;
    run.served += paid;
    this.#pod.tokens -= paid;
  }

  /** Lets go every ack there are tokens for now, the run that has spent least first, and comes
   * back when the next could go: what its timer calls, and a seam for tests on a clock of their
   * own. */
  serve(): void {
    if (this.#serving) return;
    this.#serving = true;
    try {
      this.#serveNow();
    } finally {
      this.#serving = false;
    }
  }

  #serveNow() {
    const at = this.#now();
    // Whatever a send throws, the line is come back to.
    try {
      this.#refill(this.#pod, this.rate, this.burst, at);
      for (const run of this.#active) this.#refill(run, this.runRate, this.runBurst, at);
      while (this.#active.size > 0 && this.#pod.tokens >= 1) {
        let best: Run | undefined;
        for (const run of this.#active) {
          // What it owes the process is paid from the process's tokens alone: its own bucket
          // was charged already.
          if (
            (run.owed > 0 || run.tokens >= 1) && (best === undefined || run.served < best.served)
          ) {
            best = run;
          }
        }
        if (best === undefined) break;
        if (best.owed > 0) {
          // What it owes goes first, and no further than the process's tokens: the process is
          // never put into debt for it.
          this.#pay(best, this.#pod.tokens);
          if (best.live === 0 && best.owed === 0) this.#leave(best);
          continue;
        }
        while (best.queue[best.head].send === null) best.head++;
        const one = best.queue[best.head++];
        const send = one.send!;
        one.send = null;
        best.live--;
        if (best.live === 0) this.#leave(best);
        else if (best.head > DEAD_SLACK && 2 * best.head >= best.queue.length) {
          // What was sent is dropped once it is half the queue: a run that never stops waiting
          // does not keep every ack it was ever sent.
          best.queue = best.queue.slice(best.head);
          best.head = 0;
        }
        this.#spend(best, one.cost);
        send();
      }
    } finally {
      this.#schedule(at);
    }
  }

  /** Comes back to serve once the process has a token and some waiting run has one too (or
   * owes); never later than a timer already set for it, and with no timer while nothing waits. */
  #schedule(at: number) {
    if (this.#active.size === 0) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      return;
    }
    const wait = (bucket: Bucket, rate: number) =>
      bucket.tokens >= 1 ? 0 : (1 - bucket.tokens) * 1000 / rate;
    let soonest = Infinity;
    for (const run of this.#active) {
      soonest = Math.min(soonest, run.owed > 0 ? 0 : wait(run, this.runRate));
    }
    const due = at + Math.max(1, Math.ceil(Math.max(wait(this.#pod, this.rate), soonest)));
    if (this.#timer !== undefined && this.#due <= due) return;
    clearTimeout(this.#timer);
    this.#due = due;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      // Thrown from a timer, a send's error would take the process down; the line was come back
      // to all the same (`#serveNow`).
      try {
        this.serve();
      } catch (error) {
        this.#log(error);
      }
    }, due - at);
    // A live tunnel's socket keeps its process alive; this must not keep a dead one's.
    (this.#timer as { unref?: () => void }).unref?.();
  }

  /** Forgets runs with nothing waiting or owed whose buckets have refilled, whatever they spent
   * in the stretch of contention going on: one comes back level with those waiting (`#level`),
   * and after a bucket's refill (RUN_ACK_BURST / RUN_ACK_RATE, ~170 ms) idle it is as new.
   * Otherwise a pod whose contention never broke would remember every run it ever served. */
  #prune(at: number) {
    this.#pruned = at;
    for (const [group, run] of this.#runs) {
      if (this.#active.has(run)) continue;
      this.#refill(run, this.runRate, this.runBurst, at);
      this.#refill(run.lates, this.runRate, this.runBurst, at);
      if (run.tokens >= this.runBurst && run.lates.tokens >= this.runBurst) {
        this.#runs.delete(group);
      }
    }
  }
}
