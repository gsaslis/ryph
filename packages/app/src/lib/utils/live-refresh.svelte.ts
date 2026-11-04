import { invalidate } from "$app/navigation";

/** The cadence a list asks again at, matching the detail page's polling fallback. */
const REFRESH_INTERVAL_MS = 5_000;

/**
 * Keeps a list page fresh while any of its rows is still moving. Rows advance server-side with
 * nothing pushed down to a list — the per-run stream is one run wide — so the page re-runs its
 * load on an interval, and stops the moment `isLive` reads false. An all-settled list makes no
 * requests.
 *
 * Call during component initialization: it owns an effect.
 *
 * @param dependency The load's `depends` key to invalidate.
 * @param isLive Reads whether anything on the page can still change on its own.
 */
export function refreshWhileLive(dependency: string, isLive: () => boolean): void {
  $effect(() => {
    if (!isLive()) return;
    const poll = setInterval(() => void invalidate(dependency), REFRESH_INTERVAL_MS);
    return () => clearInterval(poll);
  });
}
