// The screencast's rate limit. Chromium sends a frame per paint — ~55 fps measured on an
// animating page — and every one of them is acked at once so Chromium keeps sending (an unacked
// screencast stalls). What goes on to the live stream is at most one frame per `intervalMs`:
// a viewer watching an agent work does not need 55 fps, and every frame is ~11 KB that the relay,
// the historian and each viewer carry.
//
// The rule that matters is the TRAILING one: a frame that arrives inside the window is held,
// replacing any frame already held, and sent when the window closes. A burst therefore always
// ends on its last frame — the state the page settled in — and a static page, which sends one
// frame and then nothing, is never left showing the frame before.
//
// Pure: the clock and the timer are injected, so the tests drive time by hand.

/** A timer's handle, whatever the runtime makes of it. */
export type TimerId = ReturnType<typeof setTimeout>;

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export class Throttle<T> {
  #last = -Infinity;
  #held: { value: T } | null = null;
  #timer: TimerId | null = null;

  constructor(
    private readonly intervalMs: number,
    private readonly send: (value: T) => void,
    private readonly timers: Timers = realTimers,
  ) {}

  push(value: T): void {
    const now = this.timers.now();
    if (this.#timer === null && now - this.#last >= this.intervalMs) {
      this.#last = now;
      this.send(value);
      return;
    }
    this.#held = { value };
    if (this.#timer === null) {
      const wait = Math.max(0, this.#last + this.intervalMs - now);
      this.#timer = this.timers.setTimeout(() => this.#flush(), wait);
    }
  }

  #flush(): void {
    this.#timer = null;
    const held = this.#held;
    this.#held = null;
    if (held === null) return;
    this.#last = this.timers.now();
    this.send(held.value);
  }

  /**
   * Drops whatever is held, without sending it: the tab it came from is no longer shown. The
   * window is kept — a tab switch is not a licence to send two frames 10 ms apart.
   */
  reset(): void {
    if (this.#timer !== null) this.timers.clearTimeout(this.#timer);
    this.#timer = null;
    this.#held = null;
  }
}
