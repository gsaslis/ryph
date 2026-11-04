<script lang="ts">
import { parsePatchFiles, type Virtualizer } from "@pierre/diffs";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import * as Alert from "$lib/components/ui/alert";
import * as Empty from "$lib/components/ui/empty";
import * as ToggleGroup from "$lib/components/ui/toggle-group";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import { inTreeOrder, totalStats, treeStatuses } from "./diff-files";
import PatchFileDiff from "./patch-file-diff.svelte";
import PatchFileTree from "./patch-file-tree.svelte";

let { id, diff, truncated, omitted, moreOmitted }: {
  /** What names this diff's content — its base and head. The highlighter caches by file, page
   * long and across patches, so each file's cache key starts with it: another patch touching the
   * same path must never be drawn with this one's lines. */
  id: string;
  /** Unified `git diff` text, every file in one. */
  diff: string;
  /** The text was cut at the server's cap: the files past it are not here. */
  truncated: boolean;
  /** The files the cut left out. */
  omitted: string[];
  /** More files are left out than `omitted` names. */
  moreOmitted: boolean;
} = $props();

// The parse is only the text split into files and hunks; the highlighting is each file's own,
// and happens as it scrolls into view.
const files = $derived(
  inTreeOrder(parsePatchFiles(diff, id).flatMap((patch) => patch.files)),
);
// Each path once: a path that changed kind (a file become a symlink) is a deletion and an addition
// of the same name, two diffs but one entry in the tree.
const paths = $derived([...new Set(files.map((file) => file.name))]);
const statuses = $derived(treeStatuses(files));
const total = $derived(totalStats(files));

const STYLE_KEY = "ryph:patch-diff-style";
const readStyle = (): "unified" | "split" => {
  try {
    return localStorage.getItem(STYLE_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
};
let diffStyle = $state<"unified" | "split">(
  typeof localStorage === "undefined" ? "unified" : readStyle(),
);
function setStyle(value: string) {
  if (value !== "unified" && value !== "split") return;
  diffStyle = value;
  try {
    localStorage.setItem(STYLE_KEY, value);
  } catch {
    // A remembered choice is a convenience; without storage it is this visit's only.
  }
}

// Each file's boxes, by path, in page order: the tree jumps to a path's first, and the scroll
// reads which path is on top. Usually one; a path that changed kind has two (`paths`), and the
// first of them, its deletion, is where it begins.
const boxes = new Map<string, HTMLElement[]>();
const anchor = (path: string) => boxes.get(path)?.[0];
const register = (path: string) => (el: HTMLElement) => {
  const all = boxes.get(path) ?? [];
  all.push(el);
  all.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  boxes.set(path, all);
  return () => {
    const left = (boxes.get(path) ?? []).filter((box) => box !== el);
    if (left.length === 0) boxes.delete(path);
    else boxes.set(path, left);
  };
};

let current = $state<string | null>(null);

// One virtualizer over the window for every file, so only what is on screen is in the DOM: a
// patch of thousands of files scrolls as one of ten. And highlighting in workers, so a long file
// colouring in does not hold the page while it scrolls. Both are made here, in the browser, and
// the files wait for them. A renderer that cannot be set up at all leaves every file plain, never
// blank.
let virtualizer = $state.raw<Virtualizer | null>(null);
let pool = $state.raw<WorkerPoolManager | null>(null);
let unrendered = $state(false);
$effect(() => {
  let disposed = false;
  let made: Virtualizer | undefined;
  void (async () => {
    try {
      const [{ Virtualizer }, workers] = await Promise.all([
        import("@pierre/diffs"),
        startWorkers(),
      ]);
      if (disposed) return;
      made = new Virtualizer();
      made.setup(document);
      pool = workers;
      virtualizer = made;
    } catch (err) {
      console.error(err);
      if (!disposed) unrendered = true;
    }
  })();
  return () => {
    disposed = true;
    made?.cleanUp();
    virtualizer = null;
  };
});

/** The highlighting workers, or null where the browser will not start them: the files then
 * highlight on the main thread, slower but whole. */
async function startWorkers(): Promise<WorkerPoolManager | null> {
  try {
    const [{ getOrCreateWorkerPoolSingleton }, { default: HighlightWorker }] = await Promise.all([
      import("@pierre/diffs/worker"),
      import("@pierre/diffs/worker/worker.js?worker"),
    ]);
    return getOrCreateWorkerPoolSingleton({
      poolOptions: {
        workerFactory: () => new HighlightWorker(),
        poolSize: Math.min(4, Math.max(1, (navigator.hardwareConcurrency ?? 2) - 1)),
      },
      highlighterOptions: {
        theme: { dark: "pierre-dark", light: "pierre-light" },
        tokenizeMaxLineLength: 1_000,
      },
    });
  } catch {
    return null;
  }
}

/** The file whose box has reached the line under the sticky headers, or the first before any has.
 * The line is a box's scroll margin, in pixels as the browser resolved it: where a jump lands. */
function fileOnTop(): string | null {
  const first = paths.length === 0 ? undefined : anchor(paths[0]);
  if (first === undefined) return null;
  const line = parseFloat(getComputedStyle(first).scrollMarginTop) + 1;
  let top: string | null = paths[0] ?? null;
  for (const path of paths) {
    const box = anchor(path);
    if (box === undefined) continue;
    if (box.getBoundingClientRect().top <= line) top = path;
    else break;
  }
  return top;
}

// While a jump is landing the scroll is the jump's, not the reader's, and says nothing about which
// file they are reading: a short file near the end may never reach the line at all. The reader's
// own next input ends the landing and hands the highlight back to the scroll.
let landing: string | null = null;
let frame = 0;
let reland: ReturnType<typeof setTimeout> | undefined;
function onscroll() {
  if (landing !== null || frame !== 0) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    current = fileOnTop();
  });
}
function release() {
  if (landing === null) return;
  landing = null;
  onscroll();
}

function jump(path: string) {
  const box = anchor(path);
  if (box === undefined) return;
  landing = path;
  current = path;
  box.scrollIntoView({ block: "start" });
  // Files drawn on the way in grow or shrink from the size their placeholder guessed, which moves
  // the target: once they have, land on it again.
  clearTimeout(reland);
  reland = setTimeout(() => {
    if (landing === path) box.scrollIntoView({ block: "start" });
  }, 300);
}

$effect(() => () => {
  cancelAnimationFrame(frame);
  clearTimeout(reland);
});
</script>

<svelte:window
  {onscroll}
  onwheel={release}
  ontouchstart={release}
  onkeydown={release}
  onpointerdown={release}
/>

<!-- `--diff-sticky-top`: the bottom of the app's bar, which from md up sits under the panel's cap.
     File headers stick there (it crosses into their shadow roots), the tree a little lower. -->
<section
  class="flex flex-col gap-4 [--diff-sticky-top:--spacing(14)] md:[--diff-sticky-top:calc(var(--panel-cap)+--spacing(14))]"
>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h2 class="flex items-baseline gap-3 text-base font-medium">
      {files.length}
      {files.length === 1 ? "file" : "files"} changed
      <span class="text-sm font-normal tabular-nums">
        <span class="text-success">+{total.additions}</span>
        <span class="text-destructive">−{total.deletions}</span>
      </span>
    </h2>
    <ToggleGroup.Root
      type="single"
      variant="outline"
      size="sm"
      value={diffStyle}
      onValueChange={setStyle}
      aria-label="Diff layout"
    >
      <ToggleGroup.Item value="unified">Unified</ToggleGroup.Item>
      <ToggleGroup.Item value="split">Split</ToggleGroup.Item>
    </ToggleGroup.Root>
  </div>

  {#if truncated}
    <Alert.Root>
      <TriangleAlertIcon />
      <Alert.Title>This diff is too large to show in full</Alert.Title>
      <Alert.Description class="flex flex-col gap-2">
        {#if omitted.length > 0}
          <span>
            {#if moreOmitted}
              More than {omitted.length} files are left out, among them:
            {:else}
              {omitted.length === 1 ? "1 file is" : `${omitted.length} files are`} left out:
            {/if}
          </span>
          <ul class="max-h-40 overflow-y-auto font-mono text-xs">
            {#each omitted as path (path)}
              <li class="truncate">{path}</li>
            {/each}
          </ul>
        {:else}
          <span>Some files are left out.</span>
        {/if}
      </Alert.Description>
    </Alert.Root>
  {/if}

  {#if files.length === 0}
    {#if !truncated}
      <Empty.Root class="border border-dashed">
        <Empty.Header>
          <Empty.Title>No changes</Empty.Title>
          <Empty.Description>This patch changes no files.</Empty.Description>
        </Empty.Header>
      </Empty.Root>
    {/if}
  {:else}
    <div class="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <!-- The tree's cell stretches to the files' height, and the tree is capped at it: a short
           diff ends the tree with it rather than leaving a panel running on below. Size-contained,
           so the tree's own height never props the row open past the files'. -->
      <div class="hidden [contain:size] lg:block">
        <aside
          class="bg-card sticky top-[calc(var(--diff-sticky-top)+1rem)] h-[calc(100dvh-var(--diff-sticky-top)-2rem)] max-h-full overflow-hidden rounded-xl border py-1"
          aria-label="Changed files"
        >
          <PatchFileTree {paths} {statuses} selected={current} onselect={jump} />
        </aside>
      </div>
      <div class="flex min-w-0 flex-col gap-3">
        {#each files as file (`${file.type}:${file.name}`)}
          <div {@attach register(file.name)} class="scroll-mt-[calc(var(--diff-sticky-top)+1rem)]">
            {#if virtualizer || unrendered}
              <!-- Without a renderer each file is plain, behind the same gate a long one waits at. -->
              <PatchFileDiff {file} {diffStyle} {virtualizer} {pool} />
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</section>
