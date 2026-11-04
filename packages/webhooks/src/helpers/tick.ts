// The host's tick around `sweep()`: never two passes at once, and never a kick lost.
//
// A kick that lands while a pass is running is the one that matters most — an ingest the
// running pass may already have looked past — so it is not dropped: it is remembered, and one
// more pass runs as soon as this one ends. Any number of kicks during a pass make one follow-up,
// not one each.

/**
 * Wraps `run` so calls never overlap and a call made while one runs is coalesced into a single
 * follow-up run. `run` should not throw; a rejection is handed to `onError` and the tick lives on.
 */
export function coalescingTick(
  run: () => Promise<void>,
  onError: (err: unknown) => void,
): () => void {
  let running = false;
  let again = false;
  const loop = async () => {
    do {
      again = false;
      try {
        await run();
      } catch (err) {
        onError(err);
      }
    } while (again);
    running = false;
  };
  return () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void loop();
  };
}
