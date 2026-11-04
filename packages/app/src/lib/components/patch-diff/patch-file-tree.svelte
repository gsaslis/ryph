<script lang="ts">
import type { GitStatusEntry } from "@pierre/trees";

let { paths, statuses, selected, onselect }: {
  /** Every file the diff touches, by its new path. */
  paths: string[];
  /** How each path changed, coloured in the tree as a forge's file list colours it. */
  statuses: GitStatusEntry[];
  /** The file being read, kept selected in the tree as the diff below scrolls. */
  selected: string | null;
  onselect: (path: string) => void;
} = $props();

let host = $state<HTMLDivElement | null>(null);
let tree = $state.raw<import("@pierre/trees").FileTree | null>(null);

// Imported on demand, as the diff renderer is: it brings its own Preact and stylesheet.
$effect(() => {
  const el = host;
  if (el === null) return;
  const currentPaths = paths;
  const currentStatuses = statuses;

  let disposed = false;
  let instance: import("@pierre/trees").FileTree | undefined;
  void (async () => {
    const { FileTree } = await import("@pierre/trees");
    if (disposed) return;
    instance = new FileTree({
      paths: currentPaths,
      gitStatus: currentStatuses,
      initialExpansion: "open",
      flattenEmptyDirectories: true,
      density: "compact",
      onSelectionChange: (chosen) => {
        const path = chosen.at(-1);
        // Only files, as a folder row only folds; and not the echo of the selection the effect
        // below made to follow the diff, which would scroll the diff to where it already is.
        if (path === undefined || path.endsWith("/") || path === selected) return;
        onselect(path);
      },
      // The tree's own surface painted with the app's tokens; custom properties cross into its
      // shadow root.
      unsafeCSS: `:host {
        --trees-bg-override: transparent;
        --trees-fg-override: var(--foreground);
        --trees-fg-muted-override: var(--muted-foreground);
        --trees-bg-muted-override: var(--muted);
        --trees-selected-bg-override: var(--accent);
        --trees-selected-fg-override: var(--accent-foreground);
        --trees-border-color-override: var(--border);
        --trees-focus-ring-color-override: var(--ring);
        --trees-font-family-override: inherit;
        --trees-git-added-color-override: var(--success);
        --trees-git-deleted-color-override: var(--destructive);
      }`,
    });
    instance.render({ containerWrapper: el });
    tree = instance;
  })();

  return () => {
    disposed = true;
    instance?.cleanUp();
    tree = null;
  };
});

// A click on the file already selected changes no selection, so the tree reports nothing; the
// reader asking to go back to its top still means it. Read off the row the click came through.
$effect(() => {
  const el = host;
  if (el === null) return;
  const onclick = (event: MouseEvent) => {
    const row = event.composedPath().find((node) =>
      node instanceof HTMLElement && node.dataset.itemPath !== undefined
    ) as HTMLElement | undefined;
    const path = row?.dataset.itemPath;
    if (path !== undefined && !path.endsWith("/") && path === selected) onselect(path);
  };
  el.addEventListener("click", onclick);
  return () => el.removeEventListener("click", onclick);
});

// The reader scrolled the diff to another file: follow it in the tree, without taking focus.
$effect(() => {
  const t = tree;
  const path = selected;
  if (t === null || path === null) return;
  const item = t.getItem(path);
  if (item === null) return;
  for (const other of t.getSelectedPaths()) {
    if (other !== path) t.getItem(other)?.deselect();
  }
  if (!item.isSelected()) item.select();
  t.scrollToPath(path, { focus: false, offset: "nearest" });
});
</script>

<div bind:this={host} class="h-full min-h-0 text-sm"></div>
