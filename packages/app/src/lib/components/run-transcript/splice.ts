/**
 * How the transcript's rows changed from one update to the next, said the way the virtualiser
 * needs to hear it.
 *
 * virtua keeps the heights it has measured in an array indexed by POSITION, not by row. When the
 * list grows or shrinks it moves that array in one of two ways: rows added at the end (`shift` off,
 * every height stays at its index) or rows added at the start (`shift` on, every height moves down
 * by the number added). Anything else — rows landing in the middle, which is what filling a gap
 * under the head of a run is — leaves some rows holding another row's height.
 *
 * A row that is on screen when that happens is never measured again: its element did not change
 * size, and its index did not change either, so nothing tells the virtualiser to look. It keeps
 * drawing it at the borrowed height until it is scrolled out of the window and back, and that is
 * the message row standing on top of the rows under it.
 */

/** One contiguous stretch that changed: `removed` rows at `at` were replaced by `added` rows. */
export interface Splice {
  at: number;
  removed: number;
  added: number;
}

/**
 * The smallest single stretch that covers every difference between two lists of row keys, or null
 * when they are the same list. Several changes far apart come out as one stretch spanning them all,
 * which is the honest answer to "what moved": everything between them may have.
 */
export function spliceOf(before: readonly string[], after: readonly string[]): Splice | null {
  const shorter = Math.min(before.length, after.length);
  let head = 0;
  while (head < shorter && before[head] === after[head]) head++;
  if (head === before.length && head === after.length) return null;
  let tail = 0;
  while (
    tail < shorter - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return { at: head, removed: before.length - head - tail, added: after.length - head - tail };
}

/**
 * What the virtualiser is told about a change: whether to hold the rows after it still (`shift`),
 * and how many rows at the top it has to measure again because holding still handed them the wrong
 * heights.
 *
 * Holding still is right only when the whole change is above the reader — `firstVisible` is the
 * index, in the list BEFORE the change, of the row at the top of the window. Rows landing there are
 * rows the reader has not reached yet, and what they are looking at must not move. A change on or
 * under the screen is the opposite: the rows above it, which are the ones being read, stay where
 * they are, and the ones after it make room.
 *
 * `remeasure` is the price of holding still with rows above the change. The virtualiser moves every
 * height down as if the rows had landed at index 0, so the rows before `at` each take a height that
 * belonged to a row further up. The ones mounted at the time keep that wrong height for as long as
 * they stay mounted; the transcript re-keys them so they mount fresh and report their own.
 */
export function placementFor(
  splice: Splice | null,
  firstVisible: number,
): { shift: boolean; remeasure: number } {
  // Same length: the virtualiser moves nothing, and every row that changed is a new element (a new
  // key) or a moved one (a new index), both of which it measures.
  if (splice === null || splice.added === splice.removed) return { shift: false, remeasure: 0 };
  const above = splice.at + splice.removed <= firstVisible;
  return above ? { shift: true, remeasure: splice.at } : { shift: false, remeasure: 0 };
}
