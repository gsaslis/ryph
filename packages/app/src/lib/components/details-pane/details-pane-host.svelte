<script lang="ts">
import ResizeHandle from "./resize-handle.svelte";
import { slide } from "svelte/transition";
import { cubicOut } from "svelte/easing";
import { prefersReducedMotion } from "svelte/motion";
import { page } from "$app/state";
import { untrack } from "svelte";
import * as Sheet from "$lib/components/ui/sheet";
import { DETAILS_PANE_MIN, detailsPane } from "./details-pane.svelte";

let {
  reserve,
}: {
  /**
   * The width to hold for the pane before the page has hydrated and handed its content over, or
   * null for none: the page says in its load that it has a pane, and the cookies say whether it
   * was left open and how wide. Without it a full page load opened wide and then narrowed.
   */
  reserve: number | null;
} = $props();

let mounted = $state(false);
$effect(() => {
  mounted = true;
});

const content = $derived(detailsPane.content);

// A sheet starts shut on every page: one left open over a link it was showing must not be open
// over the page the link led to, nor pop open again on the way back.
// Followed through a derived string: `page.url` is a new object on every load re-run, a poll's
// included, and a sheet must not shut under its reader every few seconds.
const pathname = $derived(page.url.pathname);
$effect(() => {
  void pathname;
  untrack(() => (detailsPane.sheetOpen = false));
});

/** In and out sideways when the switch was flipped; otherwise there and gone at once. */
function paneSlide(node: Element) {
  return detailsPane.sliding && !prefersReducedMotion.current
    ? slide(node, { axis: "x", duration: 220, easing: cubicOut })
    : { duration: 0 };
}
</script>

<!-- A third column, on the canvas like the tasks pane on the other side of the panel: it stands
     still and scrolls inside itself while the document — the panel — scrolls past it. Named for
     view transitions, so it holds still while the panel slides between tasks. The panel's own `m-2`
     is the gap between the two; the resize handle hangs over that gap. -->
{#if content !== null && detailsPane.docked && detailsPane.open}
  <aside
  aria-label="Details"
  class="sticky top-0 hidden h-svh shrink-0 flex-col items-end self-start py-2 md:flex [view-transition-name:details-pane]"
  style:width="{detailsPane.shownWidth}px"
  transition:paneSlide
>
  <ResizeHandle
    bind:width={detailsPane.width}
    min={DETAILS_PANE_MIN}
    max={detailsPane.maxWidth}
    label="Resize the details pane"
    oncommit={detailsPane.commitWidth}
  />
  <!-- Held at the pane's width while the slide narrows the aside around it, so the content is
       uncovered rather than squeezed; held to the right edge, so it comes in from the side. -->
  <div class="flex min-h-0 w-full flex-1 flex-col" style:min-width="{detailsPane.shownWidth}px">
      {@render content({ docked: true, close: detailsPane.close })}
    </div>
</aside>
{:else if !mounted && reserve !== null}
  <!-- Held for the server's render only, and only where it will most likely dock. -->
  <div aria-hidden="true" class="hidden shrink-0 2xl:block" style:width="{reserve}px"></div>
{/if}

<Sheet.Root
  open={content !== null && !detailsPane.docked && detailsPane.sheetOpen}
  onOpenChange={(next) => {
    if (!next) detailsPane.sheetOpen = false;
  }}
>
  <!-- Nearly the whole width on a phone, with a strip of the page left to tap out on. The pane
       brings its own close button, in line with its tabs. -->
  <Sheet.Content
    side="right"
    showCloseButton={false}
    class="bg-sidebar gap-0 p-0 data-[side=right]:w-[calc(100%_-_2.5rem)] data-[side=right]:sm:max-w-xl"
  >
    <Sheet.Title class="sr-only">Details</Sheet.Title>
    {#if content !== null}
      {@render content({ docked: false, close: detailsPane.close })}
    {/if}
  </Sheet.Content>
</Sheet.Root>
