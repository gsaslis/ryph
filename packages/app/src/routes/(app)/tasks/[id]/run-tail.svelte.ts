import { untrack } from "svelte";
import { subscribeRunEvents } from "$lib/api/history";
import type { RunHistory } from "$lib/components/run-history/run-history.svelte";
import { DetailCues } from "$lib/utils/run-refresh";

/** How long a burst of cues is let settle before the load is asked for once. */
export const CUE_SETTLE_MS = 300;

/**
 * The live tail of a run: SSE through the proxy, straight into the run's history.
 *
 * While it has failed for good, the page re-runs its load on the stream's beat instead (`lost`),
 * and that load reads what the tail would have delivered.
 */
export class RunTail {
  /** The tail failed for good, and only the load is keeping the badge and the timeline honest. */
  lost = $state(false);

  /**
   * Opens the tail of `runId` into `history`, from the newest event it holds. `behind` is told,
   * once per burst, when the tail carries a sign that something only the load holds has moved;
   * `done` when the historian closes the stream of a run that concluded. Returns how to close it.
   *
   * The grant is the one the tail opens with: a stream that reopened on each new signature would
   * replay its overlap on every poll, and one that outlives its grant fails like any other.
   */
  connect(
    runId: string,
    history: RunHistory,
    grant: string | null,
    on: { behind(): void; done(): void },
  ): () => void {
    // Read once, untracked: the caller is an effect, and the tail moves this on every event.
    let seen = untrack(() => history.lastSeq);
    // The load is re-run once for a burst of cues, not once per cue.
    const cues = new DetailCues();
    let settle: ReturnType<typeof setTimeout> | undefined;
    const sub = subscribeRunEvents(runId, {
      after: seen,
      grant,
      onEvent: (event) => {
        if (event.seq <= seen) return; // replay overlap and reconnects both repeat
        seen = event.seq;
        history.absorb(event);
        if (cues.wants(event)) {
          settle ??= setTimeout(() => {
            settle = undefined;
            on.behind();
          }, CUE_SETTLE_MS);
        }
      },
      onDone: () => on.done(),
      onError: () => {
        // SSE is permanently gone. The load carries both the run's state and what the history is
        // missing, so re-running it keeps the badge and the timeline honest without a stream; the
        // run ending then tears this — and the faster beat — down.
        this.lost = true;
      },
    });
    return () => {
      sub.close();
      this.lost = false;
      if (settle !== undefined) clearTimeout(settle);
    };
  }
}
