// One image's load, retried for a while before it is given up on. An agent can write a ref the
// runner has not finished uploading yet, so the first request may well 404 and the next succeed:
// the image is asked for again until RETRY_WINDOW_MS after its first failure, then shown as failed.
// Failed is not final: asking again (a click) starts a fresh window.

/** How long after an image's first failure it keeps being asked for. */
export const RETRY_WINDOW_MS = 10_000;
/** The wait between one failed attempt and the next. */
export const RETRY_DELAY_MS = 1_000;

export type ImageLoadState = "loading" | "loaded" | "failed";

export type Clock = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

/**
 * The URL an attempt reads. The first is the image's own; each retry adds a query the server
 * ignores, so the browser asks again rather than handing back the failure it already had. A
 * `data:` or `blob:` URL (a dev preview's drawn image) is never fetched and is left as it is.
 */
export function attemptUrl(src: string, attempt: number): string {
  if (attempt === 0 || /^(data|blob):/.test(src)) return src;
  return `${src}${src.includes("?") ? "&" : "?"}attempt=${attempt}`;
}

export class ImageRetry {
  state = $state<ImageLoadState>("loading");
  /** Bumped on each new attempt: what the `<img>` is keyed and its URL derived from. */
  attempt = $state(0);

  readonly #clock: Clock;
  /** When the current window opened: the first failure since the last (re)start. */
  #since: number | null = null;
  #timer: unknown = null;

  constructor(clock: Clock = realClock) {
    this.#clock = clock;
  }

  /** The `<img>` loaded. */
  loaded(): void {
    this.#cancel();
    this.#since = null;
    this.state = "loaded";
  }

  /** The `<img>` errored: ask again shortly, unless the window has closed. */
  errored(): void {
    if (this.state !== "loading" || this.#timer !== null) return;
    const now = this.#clock.now();
    this.#since ??= now;
    if (now - this.#since >= RETRY_WINDOW_MS) {
      this.#since = null;
      this.state = "failed";
      return;
    }
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      this.attempt += 1;
    }, RETRY_DELAY_MS);
  }

  /** Try again from a failed state, with a fresh window. */
  retry(): void {
    if (this.state !== "failed") return;
    this.#cancel();
    this.#since = null;
    this.state = "loading";
    this.attempt += 1;
  }

  /** Stop any pending attempt: the image is gone from the page. */
  dispose(): void {
    this.#cancel();
  }

  #cancel(): void {
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
  }
}
