/**
 * What the open task page already holds of its run, which a re-run of its load need not read again.
 *
 * The load re-runs again and again behind an open page — a cue from the live tail, the backstop
 * poll, an action, the grant refresh — and every one of them used to read the run's history from
 * both ends, and its bill, all over again. The page threw nearly all of it away: a history that is
 * seeded only ever takes what the tail has grown by, and the live tail had already delivered that,
 * event by event. The load has no way to know that on its own, and the page has no way to shape
 * the load, so the page says here what it holds, and the load reads around it.
 *
 * Browser only, and one slot, for the reason `shown` in the load is: on the server there is no page,
 * and module state there is shared by every request the node server handles.
 */
export interface Holding {
  /** The run the page is showing. */
  runId: string;
  /** Its history has taken a window: every later one only adds what the tail has grown by. */
  seeded: boolean;
  /** The newest seq that history holds, which is where reading it again would resume. */
  lastSeq: number;
  /** The page reads this run's bill on its own clock, and a read from the load would be a repeat. */
  billing: boolean;
}

let holder: (() => Holding | null) | null = null;

/** The page, saying what it holds, for as long as it is on screen. Returns how to stop saying it. */
export function hold(get: () => Holding | null): () => void {
  holder = get;
  return () => {
    if (holder === get) holder = null;
  };
}

/** What the page holds of `runId`; null when there is no page, or it is showing another run. */
export function holding(runId: string): Holding | null {
  const held = holder?.() ?? null;
  return held?.runId === runId ? held : null;
}

/** What the load reads of the run's history. */
export type HistoryRead =
  /** Both ends, and a small middle: the first look at this run on this page. */
  | { kind: "window" }
  /** Only what came after `after`: the page holds the rest. */
  | { kind: "since"; after: number };

/**
 * What the load has to read of a run's history, given what the page holds.
 *
 * A seeded history is read since what it holds even while the live tail is open: nothing in the
 * browser can tell a tail that is delivering from one left half-open by a sleep or a network
 * change, and this read is what heals the second. Behind a tail that is delivering it answers
 * next to nothing, and the history and the tail both drop by seq whatever they already hold.
 */
export function historyRead(held: Holding | null): HistoryRead {
  if (held === null || !held.seeded) return { kind: "window" };
  return { kind: "since", after: held.lastSeq };
}

/**
 * Whether the load reads the run's bill. The page's own poll runs only while the run is live; the
 * load that says the run is over is the one with the final word, so it always reads it.
 */
export function readsBill(held: Holding | null, terminal: boolean): boolean {
  return held === null || !held.billing || terminal;
}
