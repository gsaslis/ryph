import { RUN_REFRESH_MS } from "$lib/utils/run-refresh";

/** How often an open run page re-runs its load to renew the run grants, short of their lifetime. */
export const RUN_GRANT_REFRESH_MS = 8 * 60 * 1000;
/** While a run waits for its environment, or is still getting going: a start is a minute or two. */
export const STARTING_REFRESH_MS = 3_000;
/** While the run's live tail will not hold, the load is what keeps the badge and the timeline honest. */
export const STREAM_LOST_REFRESH_MS = 5_000;
/** While something the load carries moves on its own: a running suite, a patch or build advancing.
 * The cadence the list pages keep for the same thing. */
export const MOVING_REFRESH_MS = 5_000;

/** Everything about the page that decides how stale its load may get. */
export interface RefreshNeeds {
  /** A run has been minted: its grants lapse after ten minutes, live or not. */
  hasRun: boolean;
  /** That run is over. */
  terminal: boolean;
  /** The run is waiting for its environment to be built. */
  waitingOnBuild: boolean;
  /** The run's live tail has failed for good. */
  streamLost: boolean;
  /** The run is still getting going, or has not been minted, and nothing else follows it. */
  starting: boolean;
  /** A check suite of the run is still going, or one of its patches or builds is advancing. */
  moving: boolean;
}

/**
 * How long the page's load may go unread, given what the page is showing: the shortest of what
 * every reason it has to read again asks for. These used to be an interval each, ticking on their
 * own phases, so a live run with a running suite re-ran the whole load on two clocks at once and,
 * a slow load later, had two of them in flight. One clock, at the shortest of them, is the same
 * freshness for fewer reads. `null` is a page with nothing to keep fresh.
 */
export function refreshCadence(needs: RefreshNeeds): number | null {
  const live = needs.hasRun && !needs.terminal;
  const asks = [
    // The grants the load carries live ten minutes, and only a live run or a pending build re-runs
    // the load on its own. Any other run page left open, a finished one included, re-runs it before
    // the grants lapse, so paging the transcript back keeps working.
    needs.hasRun ? RUN_GRANT_REFRESH_MS : null,
    // The inbox, the patches and the forge writes arrive with the task detail and have no stream of
    // their own. The live tail re-runs the load when it carries a sign that one of them moved; this
    // is the backstop for what reaches no stream — a patch a person approved, the skills report
    // the runner lands once its clones are set up. Slow on purpose.
    live ? RUN_REFRESH_MS : null,
    // A run whose environment is still being built sits in provisioning, and nothing about that
    // reaches the transcript's stream — the build is not the run.
    needs.waitingOnBuild && !needs.terminal ? STARTING_REFRESH_MS : null,
    live && needs.streamLost ? STREAM_LOST_REFRESH_MS : null,
    needs.starting && !needs.waitingOnBuild ? STARTING_REFRESH_MS : null,
    needs.moving ? MOVING_REFRESH_MS : null,
  ].filter((ms) => ms !== null);
  return asks.length === 0 ? null : Math.min(...asks);
}

/** The timers the scheduler runs on: the global ones, or a test's. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The one thing on the task page that re-runs its load.
 *
 * Three ways in. A cadence, which is the most the load may go unread: it is counted from when the
 * last load started here, as the intervals it replaced counted theirs, so a load a cue asked for
 * also counts as the poll's. `request`, for a cue that knows the load is behind right now. And
 * `now`, for an action a person is waiting on.
 *
 * A cue never starts a second load while one is in flight. It is owed one more load after it,
 * since the one in flight may have read before whatever the cue knows about; any number of cues in
 * that window share that one, and any load that starts later answers it. An action does not wait
 * its turn: it starts its load at once, which SvelteKit lets supersede the one in flight, as
 * `invalidate` always did. Nor does the cadence: a load still in flight a whole cadence after it
 * started — one whose request hung on a connection a sleep left half-open — is superseded by the
 * next, as every interval's tick superseded it. Only the newest load's landing counts: one it
 * superseded never lands anything, and may never settle at all.
 */
export class RefreshScheduler {
  readonly #reload: () => Promise<void>;
  readonly #clock: Clock;
  #cadence: number | null = null;
  #timer: unknown = undefined;
  /** When what the page shows was read: the newest load's start. */
  #lastRead: number;
  /** The newest load started here. Any other still in flight has been superseded by it. */
  #generation = 0;
  /** The newest load has not landed. */
  #inFlight = false;
  /** The load owed once the one in flight lands, shared by every request made meanwhile. */
  #owed: PromiseWithResolvers<void> | null = null;
  #disposed = false;

  constructor(reload: () => Promise<void>, clock: Clock = realClock) {
    this.#reload = reload;
    this.#clock = clock;
    // The page is drawn off a load that has just landed.
    this.#lastRead = clock.now();
  }

  /** The most the load may go unread; `null` to stop reading it on a clock at all. */
  set cadence(ms: number | null) {
    if (ms === this.#cadence) return;
    this.#cadence = ms;
    this.#arm();
  }

  get cadence(): number | null {
    return this.#cadence;
  }

  /**
   * Re-run the load now, or once the one in flight lands. Resolves once a load that started after
   * this was asked has landed.
   */
  request(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (!this.#inFlight) return this.#start();
    this.#owed ??= Promise.withResolvers<void>();
    return this.#owed.promise;
  }

  /**
   * Re-run the load now, whatever is in flight, for an action a person is waiting on. Resolves once
   * that load has landed. It starts after every cue owed a load so far, so it is theirs as well.
   */
  now(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    return this.#start();
  }

  dispose(): void {
    this.#disposed = true;
    this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#owed?.resolve();
    this.#owed = null;
  }

  #start(): Promise<void> {
    const generation = ++this.#generation;
    this.#inFlight = true;
    this.#lastRead = this.#clock.now();
    // Every cue owed a load so far is answered by this one, which starts after all of them.
    const owed = this.#owed;
    this.#owed = null;
    this.#arm();
    const load = Promise.resolve().then(() => this.#reload());
    const settled = () => {
      // Superseded: the newer load is the one whose landing counts.
      if (generation !== this.#generation) return;
      this.#inFlight = false;
      const next = this.#owed;
      this.#owed = null;
      if (next !== null && !this.#disposed) this.#start().then(next.resolve, next.reject);
    };
    load.then(settled, settled);
    if (owed !== null) load.then(owed.resolve, owed.reject);
    return load;
  }

  #arm(): void {
    this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#disposed || this.#cadence === null) return;
    const wait = Math.max(0, this.#lastRead + this.#cadence - this.#clock.now());
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      // A load that fails is the load's to report; the clock just keeps going.
      this.#start().catch(() => {});
    }, wait);
  }
}
