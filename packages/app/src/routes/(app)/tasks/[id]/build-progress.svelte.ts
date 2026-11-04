import { getEnvironmentById } from "$lib/api/environments";
import type { EnvironmentView } from "$lib/api/types";

/** How often the build a run waits on is read again. */
export const BUILD_POLL_MS = 4_000;

/**
 * The build a run is waiting on — its kind and how long builds like it usually take — and a clock,
 * so the wait says how far along it is rather than only that it is happening. The build is not the
 * run, and nothing about it reaches the run's stream, so it is followed on its own.
 */
export class BuildProgress {
  build = $state.raw<EnvironmentView | null>(null);
  now = $state(Date.now());
  readonly #fetch: typeof fetch;

  constructor(f: typeof fetch = fetch) {
    this.#fetch = f;
  }

  /** Follows the build of environment `id`, or nothing; returns how to stop. */
  follow(id: string | null): (() => void) | undefined {
    this.build = null;
    if (id === null) return;
    let stopped = false;
    const read = async () => {
      this.now = Date.now();
      try {
        const build = await getEnvironmentById(this.#fetch, id);
        if (!stopped) this.build = build;
      } catch {
        // The progress line is a courtesy too.
      }
    };
    void read();
    const poll = setInterval(read, BUILD_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(poll);
    };
  }
}
