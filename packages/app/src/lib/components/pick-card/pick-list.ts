/** A list this long or shorter is shown whole, with no search and no "Show all". */
export const PICK_SHOW_WHOLE = 8;
/** How many a longer list shows until it is opened up or searched. */
export const PICK_CAP = 6;

export type PickWindow<T> = {
  /** The items to draw, in list order. */
  shown: T[];
  /** How many of the list are folded away; 0 when it is whole or searched. */
  folded: number;
};

/**
 * Which of a pick list's items are on screen. A search shows every match; otherwise a long list
 * shows its first `cap` until it is opened up. The picked item is never folded away: when it lies
 * past the cap, it takes the last place in the window, so what is picked can always be seen.
 */
export function pickWindow<T>(
  items: readonly T[],
  opts: {
    key: (item: T) => string;
    /** What a search matches against: the words a person would call it by. */
    text: (item: T) => string;
    query: string;
    expanded: boolean;
    selected: string;
    cap?: number;
    showWhole?: number;
  },
): PickWindow<T> {
  const cap = opts.cap ?? PICK_CAP;
  const showWhole = opts.showWhole ?? PICK_SHOW_WHOLE;
  const words = opts.query.trim().toLowerCase().split(/\s+/).filter((w) => w !== "");
  if (words.length > 0) {
    const shown = items.filter((item) => {
      const text = opts.text(item).toLowerCase();
      return words.every((word) => text.includes(word));
    });
    return { shown, folded: 0 };
  }
  if (opts.expanded || items.length <= showWhole) return { shown: [...items], folded: 0 };

  const head = items.slice(0, cap);
  const picked = opts.selected === ""
    ? undefined
    : items.find((item) => opts.key(item) === opts.selected);
  const shown = picked === undefined || head.includes(picked)
    ? head
    : [...items.slice(0, cap - 1), picked];
  return { shown, folded: items.length - shown.length };
}

/** Whether a list is long enough to be searched. */
export function pickSearchable(count: number, showWhole = PICK_SHOW_WHOLE): boolean {
  return count > showWhole;
}

/**
 * The item a picker starts on: the one picked last time, while it is still there, else the only
 * one there is, else none ("").
 */
export function preselect(ids: readonly string[], remembered: string | null | undefined): string {
  if (remembered && ids.includes(remembered)) return remembered;
  return ids.length === 1 ? ids[0] : "";
}
