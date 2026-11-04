import { getRunUsageState, type RunUsageState } from "$lib/api/model-usage";
import { deferredResults } from "$lib/utils/deferred-results";

/** How often a live run's bill is read again. One aggregate per model, however long the run. */
export const USAGE_POLL_MS = 5_000;

const NO_USAGE: RunUsageState = { usage: null, unavailable: false };

/**
 * What the run's model calls cost, as the model proxy metered them: read with the load, and on a
 * clock of its own while the run is live, since the proxy writes a row as each call's response
 * ends and the bill grows the whole time.
 *
 * Both land here, and the newest read asked for is the one shown, whichever answers first. A bill
 * is secondary, so a refresh never cancels a slow read; only a newer completed one supersedes it.
 * It is kept for its run during refreshes, and never shown for another.
 */
export class RunBill {
  readonly #runId: () => string | null;
  readonly #fetch: typeof fetch;
  #held = $state.raw<{ runId: string | null; value: RunUsageState } | null>(null);
  readonly #adopt = deferredResults<RunUsageState>();
  /** The run whose bill is being polled. Plain, not state: only the load reads it. */
  #polling: string | null = null;

  /** `runId` reads the run the page is on now. */
  constructor(runId: () => string | null, f: typeof fetch = fetch) {
    this.#runId = runId;
    this.#fetch = f;
  }

  /** The bill of the run the page is on, as last read; empty until one has been. */
  get current(): RunUsageState {
    const held = this.#held;
    return held !== null && held.runId === this.#runId() ? held.value : NO_USAGE;
  }

  /** Whether the bill of `runId` is being read on this clock, so that a load need not. */
  polls(runId: string): boolean {
    return this.#polling === runId;
  }

  /** A read of `runId`'s bill, adopted once it answers, if it is still the newest and still the
   * run on screen. `live` says whether the asker still wants it. */
  take(runId: string | null, pending: Promise<RunUsageState>, live: () => boolean = () => true) {
    void this.#adopt(pending, (value) => {
      if (live() && this.#runId() === runId) this.#held = { runId, value };
    }).catch(() => {
      // A read that failed: the next one says it again, and until then the bill is what it was.
    });
  }

  /**
   * Reads `runId`'s bill every `USAGE_POLL_MS` until stopped. A read in flight when it stops — the
   * run settling, say — lands after and is thrown away, so the concluding load, which reads the
   * bill as well, has the final word. Returns how to stop.
   */
  poll(runId: string, grant: () => string | null): () => void {
    let stopped = false;
    this.#polling = runId;
    const timer = setInterval(() => {
      this.take(runId, getRunUsageState(this.#fetch, runId, grant()), () => !stopped);
    }, USAGE_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      if (this.#polling === runId) this.#polling = null;
    };
  }
}
