<script lang="ts">
import { mode } from "mode-watcher";

let { name, patch = null, content = null, onready = () => {} }: {
  /** The file's path — the header, and what the language is inferred from. */
  name: string;
  /** A unified patch (an `edit`'s own account of what it changed). */
  patch?: string | null;
  /** A whole new file (a `write`), rendered as all additions against nothing. */
  content?: string | null;
  /**
   * Drawn, and now the size it will actually be — the caller cannot animate to a height this
   * has not reached yet. Also fires when the diff fails to draw: a caller waiting to reveal
   * this must not be left waiting forever.
   */
  onready?: () => void;
} = $props();

let host = $state<HTMLDivElement | null>(null);

// Shiki's grammars and themes ride behind the renderer, so it is imported on demand rather than
// bundled into the page: most of a run's timeline is tool calls nobody opens.
$effect(() => {
  const el = host;
  if (el === null) return;

  // Read every reactive input up front — after the first `await` this effect is no longer
  // tracking, so anything read later would silently never re-run.
  const themeType = mode.current === "dark" ? "dark" : "light";
  const currentPatch = patch;
  const currentContent = content;
  const currentName = name;

  let disposed = false;
  let instance: { cleanUp(): void } | undefined;

  void (async () => {
    try {
      const { FileDiff, getSingularPatch } = await import("@pierre/diffs");
      if (disposed) return; // torn down while the chunk was in flight

      const diff = new FileDiff({
        diffStyle: "unified",
        // The library's own colours, told which mode to draw in. It writes `color-scheme` from
        // this, which is what its `light-dark()` values resolve against — worth passing explicitly
        // rather than leaving to the OS, since this app's dark mode is a class, not a media query.
        themeType,
        disableFileHeader: true,
        overflow: "scroll",
      });
      instance = diff;
      if (disposed) return;

      // `containerWrapper`, never `fileContainer`: handed a bare element the renderer uses it as-is
      // and every style is lost — the layout grid and the diff colours live in the shadow root of
      // its own <diffs-container>, which it only creates when the container is left to it. Passing
      // the wrapper makes it build that element inside this div; `cleanUp` then removes it again.
      if (currentPatch !== null) {
        diff.render({ fileDiff: getSingularPatch(currentPatch), containerWrapper: el });
      } else {
        diff.render({
          oldFile: { name: currentName, contents: "" },
          newFile: { name: currentName, contents: currentContent ?? "" },
          containerWrapper: el,
        });
      }
      if (!disposed) onready();
    } catch {
      // A diff that will not draw must not take the timeline down with it; the call's own
      // summary text is rendered above regardless, so the row still says what happened.
      if (!disposed) onready();
    }
  })();

  return () => {
    disposed = true;
    instance?.cleanUp();
  };
});
</script>

<!-- Rounded and clipped: the diff brings its own square-cornered surface, which reads as a foreign
     panel sitting inside a card whose own corners are round. -->
<div bind:this={host} class="overflow-hidden rounded-xl"></div>
