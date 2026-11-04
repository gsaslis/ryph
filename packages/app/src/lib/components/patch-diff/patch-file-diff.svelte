<script lang="ts">
import type { FileDiffMetadata, Virtualizer } from "@pierre/diffs";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import { Button } from "$lib/components/ui/button";
import { mode } from "mode-watcher";
import { fileStats } from "./diff-files";
import PatchFilePlain from "./patch-file-plain.svelte";

let { file, diffStyle, virtualizer, pool }: {
  file: FileDiffMetadata;
  diffStyle: "unified" | "split";
  /** The page's one virtualizer: it draws only the lines of this file that are on screen. Null
   * where the renderer could not be set up at all: the file is shown plain. */
  virtualizer: Virtualizer | null;
  /** Highlights off the main thread; null where workers could not be started. */
  pool: WorkerPoolManager | null;
} = $props();

/** Past this many rows a file waits to be asked for: a lockfile would bury the change. */
const LARGE = 3000;
const stats = $derived(fileStats(file));
let opened = $state(false);
const open = $derived(opened || file.unifiedLineCount <= LARGE);

let host = $state<HTMLDivElement | null>(null);
/** The renderer would not draw this file: it is shown as plain lines instead, never blank. */
let failed = $state(false);

$effect(() => {
  const el = host;
  if (el === null || !open || failed || virtualizer === null) return;

  // Read every reactive input before the first `await`: the effect stops tracking after it.
  const themeType = mode.current === "dark" ? "dark" : "light";
  const currentFile = file;
  const currentStyle = diffStyle;
  const currentVirtualizer = virtualizer;
  const currentPool = pool;

  let disposed = false;
  let instance: { cleanUp(): void } | undefined;
  let container: HTMLElement | undefined;
  void (async () => {
    try {
      const { DIFFS_TAG_NAME, VirtualizedFileDiff } = await import("@pierre/diffs");
      if (disposed) return;
      const diff = new VirtualizedFileDiff(
        {
          diffStyle: currentStyle,
          themeType,
          overflow: "scroll",
          stickyHeader: true,
          // Highlighting gives way to plain text on a file too long or a line too wide to be
          // worth colouring: a minified bundle is one line of a megabyte.
          tokenizeMaxLength: 20_000,
          tokenizeMaxLineLength: 1_000,
          // The header sticks under the page's own bar, not at the window's top, and the file's
          // surface is the card's, as a code block's is elsewhere in the app.
          unsafeCSS: `
            :host { --diffs-bg: var(--card); }
            [data-diffs-header][data-sticky] { top: calc(var(--diff-sticky-top, 1px) - 1px); }
          `,
        },
        currentVirtualizer,
        undefined,
        currentPool ?? undefined,
      );
      instance = diff;
      // The renderer's own element, in place BEFORE it renders: a virtualized file measures where
      // it sits to decide whether it is on screen, and one handed a wrapper instead builds its
      // element detached, measures nothing, and draws every file at once. Its own element, not a
      // bare div, which would lose the styles it keeps in that element's shadow root.
      container = document.createElement(DIFFS_TAG_NAME);
      el.append(container);
      diff.render({ fileDiff: currentFile, fileContainer: container });
    } catch (err) {
      // One file that will not draw must not take the others with it, nor go blank: what is
      // approved must be readable, so it is shown plain.
      console.error(err);
      if (!disposed) failed = true;
    }
  })();

  return () => {
    disposed = true;
    instance?.cleanUp();
    container?.remove();
  };
});
</script>

{#if open && (failed || virtualizer === null)}
  <PatchFilePlain {file} />
{:else if open}
  <!-- Clipped, not hidden: a hidden overflow is a scroll box, and the sticky header would stick
       to it instead of to the page. -->
  <div bind:this={host} class="bg-card overflow-clip rounded-xl border"></div>
{:else}
  <div class="bg-card flex items-center gap-3 rounded-xl border px-4 py-2.5 text-sm">
  <span class="min-w-0 truncate font-mono">{file.name}</span>
  <span class="shrink-0 text-xs tabular-nums">
    <span class="text-success">+{stats.additions}</span>
    <span class="text-destructive">−{stats.deletions}</span>
  </span>
  <Button
    variant="outline"
    size="xs"
    class="ml-auto"
    onclick={() => {
        opened = true;
      }}
  >
      Show diff
    </Button>
</div>
{/if}
