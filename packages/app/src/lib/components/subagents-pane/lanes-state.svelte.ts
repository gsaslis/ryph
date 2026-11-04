import type { LaneSummary } from "$lib/api/history";
import { type Subagent, subagentsOf, withLane } from "$lib/utils/subagents";

/**
 * One run's subagents as the page holds them: the lanes the historian's feed (or its listing) has
 * said, and the list the tab draws from them. One per run, made by the page, for the reason the
 * run's history is: the page outlives a run.
 */
export class LanesState {
  readonly #runEndedAt: () => number | null;

  /** In start order, each the latest summary said of it. */
  lanes = $state.raw<readonly LaneSummary[]>([]);
  /** The feed has opened or the listing been read at least once. */
  loaded = $state(false);

  /** The subagents, settled against the run's end once it has one. */
  readonly subagents: Subagent[] = $derived.by(() => subagentsOf(this.lanes, this.#runEndedAt()));
  /** How many are running now. */
  readonly running: number = $derived(
    this.subagents.filter((s) => s.runningSince !== null).length,
  );

  constructor(runEndedAt: () => number | null = () => null) {
    this.#runEndedAt = runEndedAt;
  }

  /** One lane as the feed said it: it replaces its own row, or joins the list. */
  apply(lane: LaneSummary): void {
    this.lanes = withLane(this.lanes, lane);
    this.loaded = true;
  }

  /** The whole listing, read at once. */
  replace(lanes: readonly LaneSummary[]): void {
    this.lanes = lanes;
    this.loaded = true;
  }

  /** The feed opened: whatever lanes there are are on their way. */
  opened(): void {
    this.loaded = true;
  }
}
