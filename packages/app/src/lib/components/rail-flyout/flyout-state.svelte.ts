/**
 * The card beside the collapsed sidebar: which nav item it is showing and where.
 *
 * ONE card for the whole rail rather than a tooltip per icon, so moving down the rail glides it
 * from icon to icon instead of closing one popup and opening the next. It is also a card you can
 * move INTO — a tooltip vanishes the moment the pointer leaves its trigger, which is exactly why
 * the sub-pages of a folding item were unreachable on the rail — so leaving an icon only closes
 * it after a beat, and entering the card cancels that.
 */
export class RailFlyout<T> {
  /**
   * What the card shows. Kept after it closes, so the fade-out still has something to show. Raw,
   * because the card keys its content on this: a deep `$state` wrapped each item in a fresh proxy,
   * so pointing the card at the item it already showed (focus following a click, the hover coming
   * back after a page transition) read as a new item and faded the content in again.
   */
  current = $state.raw<T | null>(null);
  open = $state(false);
  /** Viewport coordinates of the hovered row's top and right edges. */
  top = $state(0);
  left = $state(0);
  /**
   * True from the moment the card appears until the pointer moves to another row: it should
   * appear AT the row and at its new size, fading in, not slide and resize from wherever it was
   * last closed. Held for the whole visit rather than one frame, because the size is measured off
   * the new content a frame or two AFTER it renders — a one-frame hold let that measurement
   * animate from the old size. Moves between rows while it is open are what animate.
   */
  instant = $state(true);

  #hideTimer: ReturnType<typeof setTimeout> | undefined;
  #delay: number;
  #held = false;

  constructor(hideDelayMs = 160) {
    this.#delay = hideDelayMs;
  }

  /** Point the card at `item`, beside the row `target` (any element inside the row). */
  show(item: T, target: Element) {
    clearTimeout(this.#hideTimer);
    const row = target.getBoundingClientRect();
    this.instant = !this.open;
    this.current = item;
    this.top = row.top;
    // Just past the row itself, which ends a few pixels inside the rail: close enough to read as
    // the icon's own label, with room for the gap the pointer crosses on its way in.
    this.left = row.right + 6;
    this.open = true;
  }

  /** The pointer or focus left: close after a beat, unless something takes it back first. */
  hideSoon() {
    if (this.#held) return;
    clearTimeout(this.#hideTimer);
    this.#hideTimer = setTimeout(() => (this.open = false), this.#delay);
  }

  /** The pointer or focus arrived in the card itself. */
  keep() {
    clearTimeout(this.#hideTimer);
  }

  hideNow() {
    clearTimeout(this.#hideTimer);
    this.open = false;
  }

  /**
   * A navigation started: stay as it is until `release`. The page transition takes the pointer's
   * hover away while it runs and the navigation resets focus, so the card would get a leave it
   * should not act on and then, once the transition ended over the same row, an enter that
   * brought it straight back.
   */
  hold() {
    clearTimeout(this.#hideTimer);
    this.#held = true;
  }

  /**
   * The transition is over. Close after the usual beat; if the pointer is still over a row or the
   * card, the enter the browser sends now that hover is back takes the card back first.
   */
  release() {
    this.#held = false;
    if (this.open) this.hideSoon();
  }
}
