<script lang="ts" module>
/** Logs past this are drawn as plain text; see HIGHLIGHT_MAX_CHARS below. */
const LOG_LANG = "log";

let warming: Promise<typeof import("@pierre/diffs")> | null = null;

/**
 * Fetches the renderer and readies its highlighter, once per page. A view that is about to show a
 * log calls it early (while the log itself is still being read), so that by the time there is
 * text the first draw is the finished one rather than a blank pane or a plain stand-in.
 */
export function warmLogView(): Promise<typeof import("@pierre/diffs")> {
  warming ??= import("@pierre/diffs").then(async (diffs) => {
    await diffs.preloadHighlighter(diffs.getHighlighterOptions(LOG_LANG, {}));
    return diffs;
  });
  // A failed fetch is tried again by the next view rather than remembered.
  warming.catch(() => (warming = null));
  return warming;
}
</script>

<script lang="ts">
import { mode } from "mode-watcher";
import { untrack } from "svelte";

let { text, wrap = false, line = null, class: className }: {
  /** Shown as plain text, never as markup. A new value is drawn in place, keeping the reader's
   * place, or the end if that is where they were. */
  text: string;
  /** Long lines wrap under their own number rather than scroll sideways. */
  wrap?: boolean;
  /** A line to show and mark, one-based: a find bar's current match. */
  line?: number | null;
  class?: string;
} = $props();

// The renderer the transcript's file views use, virtualized: a log can run to 4 MB, and only the
// rows in view are ever in the document. It scrolls itself, inside `scroller`.
let scroller = $state<HTMLDivElement | null>(null);
let content = $state<HTMLDivElement | null>(null);
// The plain text stands in only when the renderer fails or is very slow to arrive: once it is
// warm a log is drawn in a few milliseconds, and a stand-in that is replaced moments later only
// flashes. A log can be too long to hand the document whole, so it is the end of it, which is
// where a reader starts anyway.
const FALLBACK_LINES = 400;
const FALLBACK_AFTER_MS = 1500;
// Highlighting tokenizes the whole log at once, on the main thread, at about 3 MB a second on a
// fast machine: a 256 KB log costs some 100 ms, a 4 MB one over a second, longer on a slow one.
// Past this a log is drawn as plain text, which costs next to nothing at any size.
const HIGHLIGHT_MAX_CHARS = 256_000;
/** The longest a place in the log is held while its rows settle. */
const HOLD_MS = 2000;
/** How close to the end still counts as being there, in pixels. */
const AT_END = 24;
/** What says the reader has taken over the scrolling. */
const READER_INPUT = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
// A parent's poll may replace the record behind `text` without changing its value. Keep a
// primitive boundary so that does not redraw the log and scroll it back to the end.
const contents = $derived(text);
const fallback = $derived(contents.split("\n").slice(-FALLBACK_LINES).join("\n"));
let drawn = $state(false);
let late = $state(false);

type Instance = {
  file: import("@pierre/diffs").VirtualizedFile;
  virtualizer: import("@pierre/diffs").Virtualizer;
};
let instance = $state.raw<Instance | null>(null);
// Where the pane is held while its rows settle: a new log's end, or a found line. Rows are measured
// as they draw, wrapped ones taller than estimated, so a place worked out before they draw moves
// once they do: whenever the log's height changes the place is taken again, until the reader
// scrolls or clicks, or the hold runs out. Scrolls are set on the element itself: the virtualizer
// clamps its own to a height it has not measured yet.
let pin: (() => void) | null = null;
let pinTimer: ReturnType<typeof setTimeout> | undefined;

function hold(place: () => void) {
  pin = place;
  clearTimeout(pinTimer);
  pinTimer = setTimeout(() => (pin = null), HOLD_MS);
  place();
}

function holdEnd(root: HTMLElement) {
  hold(() => {
    if (root.scrollHeight - root.scrollTop - root.clientHeight > 1) {
      root.scrollTop = root.scrollHeight;
    }
  });
}

$effect(() => {
  const root = scroller;
  if (root === null) return;
  const letGo = () => (pin = null);
  for (const type of READER_INPUT) root.addEventListener(type, letGo, { passive: true });
  return () => {
    clearTimeout(pinTimer);
    for (const type of READER_INPUT) root.removeEventListener(type, letGo);
  };
});

// The renderer, made once per pane. The text is drawn into it below.
$effect(() => {
  const root = scroller;
  const host = content;
  if (root === null || host === null) return;
  // Theme and wrapping change the drawn file in place, below.
  const themeType = untrack(() => mode.current) === "dark" ? "dark" : "light";
  const overflow = untrack(() => wrap) ? "wrap" : "scroll";

  let disposed = false;
  let made: Instance | null = null;
  let unhold = () => {};
  const lateTimer = setTimeout(() => (late = true), FALLBACK_AFTER_MS);
  void (async () => {
    try {
      // The highlighter is ready once this settles, so the first draw is a whole one: drawn
      // before it, the file paints nothing and fills in on a later frame.
      const { Virtualizer, VirtualizedFile } = await warmLogView();
      if (disposed) return;
      const virtualizer = new Virtualizer();
      virtualizer.setup(root, host);
      const grows = new ResizeObserver(() => pin?.());
      grows.observe(host);
      unhold = () => grows.disconnect();
      made = {
        file: new VirtualizedFile(
          {
            themeType,
            overflow,
            disableFileHeader: true,
            unsafeCSS: ":host { --diffs-bg: var(--card); }",
            // Lines are marked only from here (`line`), never by a click.
            enableLineSelection: true,
            controlledSelection: true,
          },
          virtualizer,
        ),
        virtualizer,
      };
      instance = made;
    } catch {
      if (!disposed) late = true;
    }
  })();

  return () => {
    disposed = true;
    clearTimeout(lateTimer);
    unhold();
    late = false;
    made?.file.cleanUp();
    made?.virtualizer.cleanUp();
    instance = null;
    drawn = false;
  };
});

// The text, drawn into the one renderer: a new text replaces the old in place, with no blank
// frame between them, as when a command's stored log takes over from what was seen of it live.
$effect(() => {
  const current = instance;
  const root = scroller;
  const host = content;
  const renderedText = contents;
  if (current === null || root === null || host === null) return;
  untrack(() => {
    const first = !drawn;
    const atEnd = root.scrollHeight - root.scrollTop - root.clientHeight < AT_END;
    try {
      current.file.render({
        file: {
          name: "output.log",
          contents: renderedText,
          lang: renderedText.length > HIGHLIGHT_MAX_CHARS ? "text" : LOG_LANG,
        },
        containerWrapper: host,
      });
    } catch {
      late = true;
      return;
    }
    drawn = true;
    // A log opens at its end, where a failure says what went wrong; a found line wins. A new
    // text keeps the reader at the end if that is where they were.
    if (first ? line === null : atEnd) holdEnd(root);
  });
});

// Wrapping is an option on the drawn file, not a new one: the reader keeps their place.
$effect(() => {
  const overflow = wrap ? "wrap" : "scroll";
  const current = instance;
  if (current === null || current.file.options.overflow === overflow) return;
  current.file.setOptions({ ...current.file.options, overflow });
  current.file.rerender();
});

// So is the theme.
$effect(() => {
  const themeType = mode.current === "dark" ? "dark" : "light";
  const current = instance;
  if (current === null || current.file.options.themeType === themeType) return;
  current.file.setOptions({ ...current.file.options, themeType });
  current.file.rerender();
});

// The marked line, held in the middle of the pane.
$effect(() => {
  const current = instance;
  const root = scroller;
  const target = line;
  if (current === null || root === null) return;
  current.file.setSelectedLines(target === null ? null : { start: target, end: target });
  if (target === null) return;
  hold(() => {
    const at = current.file.getLinePosition(target);
    if (at !== undefined) root.scrollTop = at.top - (root.clientHeight - at.height) / 2;
  });
});
</script>

<div bind:this={scroller} class={["not-prose min-h-0 overflow-auto", className]}>
  <div bind:this={content}></div>
  {#if !drawn && late}
    <pre class="p-3 font-mono text-xs whitespace-pre">{fallback}</pre>
  {/if}
</div>
