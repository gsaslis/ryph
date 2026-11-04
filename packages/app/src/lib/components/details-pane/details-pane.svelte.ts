import type { Snippet } from "svelte";

/** What the pane's content is told about where it is drawn. */
export interface DetailsPaneContext {
  /** Beside the page panel, rather than in a sheet over it. */
  docked: boolean;
  /** Shuts the pane, docked or not. */
  close: () => void;
}

/** Whether the docked pane was left open, so the server renders the next page that way. */
export const DETAILS_PANE_OPEN_COOKIE = "details_pane_open";
/** The width it was dragged to, for the same reason. */
export const DETAILS_PANE_WIDTH_COOKIE = "details_pane_width";
export const DETAILS_PANE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const DETAILS_PANE_MIN = 360;
export const DETAILS_PANE_INITIAL = 440;
export const DETAILS_PANE_MAX = 820;
/** The narrowest the page panel may be squeezed to before the pane gives way to a sheet. */
export const DETAILS_PANE_PAGE_MIN = 560;

function remember(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/; max-age=${DETAILS_PANE_COOKIE_MAX_AGE}`;
}

/**
 * The pane on the canvas to the right of the page panel. It belongs to the app layout, because
 * anything a page renders lands inside the panel; a page that has a record to show beside itself
 * hands its content over here, and takes it back when it leaves.
 *
 * Set from a page's effect, so only ever on the client — module state is shared between requests
 * on the server, and a server render reads the cookies off `page.data` instead.
 */
class DetailsPane {
  /** The page's content; null on a page without a pane. */
  content = $state<Snippet<[DetailsPaneContext]> | null>(null);
  /** The docked pane is open. Remembered across pages and visits. */
  open = $state(true);
  /** Too narrow to dock, the pane is a sheet, and a sheet starts shut on every page. */
  sheetOpen = $state(false);
  /**
   * How much of the window the panel and the pane share: from the panel's left edge to the
   * window's right. The layout measures it; 0 until it has, and then the pane is taken to fit.
   * Measured from the panel's left edge rather than off the panel's own width, which the pane
   * itself changes.
   */
  room = $state(0);
  /** The width a person dragged it to. Where it is drawn is `shownWidth`. */
  width = $state(DETAILS_PANE_INITIAL);

  /** There is room for the pane beside the panel; a sheet over it when false. */
  docked = $derived(
    this.room === 0 || this.room >= DETAILS_PANE_MIN + DETAILS_PANE_PAGE_MIN,
  );
  /** The widest it can be dragged to here. */
  maxWidth = $derived(
    Math.max(DETAILS_PANE_MIN, Math.min(DETAILS_PANE_MAX, this.room - DETAILS_PANE_PAGE_MIN)),
  );
  shownWidth = $derived(
    Math.min(
      this.room === 0 ? DETAILS_PANE_MAX : this.maxWidth,
      Math.max(DETAILS_PANE_MIN, this.width),
    ),
  );

  /**
   * The docked pane's next entrance or exit is a person's doing, and slides. Set by the switches
   * below, cleared once that slide has had time to start: a page arriving with a pane, or leaving
   * with one, shows or drops it in place.
   */
  sliding = false;
  #slidingTimer: ReturnType<typeof setTimeout> | undefined;

  #slide() {
    this.sliding = true;
    clearTimeout(this.#slidingTimer);
    this.#slidingTimer = setTimeout(() => (this.sliding = false), 50);
  }

  /** On screen, whichever way it is drawn. */
  get shown(): boolean {
    return this.content !== null && (this.docked ? this.open : this.sheetOpen);
  }

  toggle = () => {
    if (this.docked) this.setOpen(!this.open);
    else this.sheetOpen = !this.sheetOpen;
  };

  /** Brings it on screen, whichever way it is drawn: something on the page asked to show it. */
  show = () => {
    if (this.docked) this.setOpen(true);
    else this.sheetOpen = true;
  };

  close = () => {
    if (this.docked) this.setOpen(false);
    else this.sheetOpen = false;
  };

  setOpen(open: boolean) {
    if (open !== this.open) this.#slide();
    this.open = open;
    remember(DETAILS_PANE_OPEN_COOKIE, String(open));
  }

  commitWidth = (width: number) => {
    remember(DETAILS_PANE_WIDTH_COOKIE, String(width));
  };
}

export const detailsPane = new DetailsPane();
