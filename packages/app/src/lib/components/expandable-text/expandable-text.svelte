<script lang="ts">
import { Button } from "$lib/components/ui/button";
import type { Snippet } from "svelte";

let {
  children,
  maxHeight = 500,
  class: className = "",
  expanded: held,
  ontoggle,
}: {
  children: Snippet;
  /** Where the cut falls, in pixels. Content shorter than this is left alone entirely. */
  maxHeight?: number;
  class?: string;
  /**
   * Whether it is open, when somebody else is holding that. The windowed transcript is: a row
   * there is unmounted as it scrolls away, and what was unfolded must still be unfolded when the
   * reader comes back to it. Left out, the box remembers for itself, as it always did.
   */
  expanded?: boolean;
  ontoggle?: (expanded: boolean) => void;
} = $props();

let own = $state(false);
const expanded = $derived(held ?? own);
function toggle(): void {
  if (ontoggle === undefined) own = !expanded;
  else ontoggle(!expanded);
}
let box = $state<HTMLDivElement | null>(null);
let overflows = $state(false);

// Measured, not guessed at from the text's length: what is too long depends on how it lays out,
// and prose that grows after the first paint — an image arriving, a code block highlighting —
// crosses the line later. Only measured while collapsed, because an expanded box has no overflow
// to report and would take its own button away.
$effect(() => {
  const node = box;
  if (node === null || expanded) return;
  const measure = () => (overflows = node.scrollHeight > node.clientHeight + 1);
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(node);
  return () => observer.disconnect();
});
</script>

<div class="flex flex-col gap-1 {className}">
  <div
    bind:this={box}
    class="relative overflow-hidden"
    style:max-height={expanded ? "none" : `${maxHeight}px`}
  >
    {@render children()}
    {#if overflows && !expanded}
      <!-- The cut is where the text stops being readable, so it is faded rather than sliced: a
           line severed mid-height reads as a rendering fault. `--card` because this is used inside
           one; on the page they are the same colour anyway. -->
      <div
        class="from-card pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t to-transparent"
      ></div>
    {/if}
  </div>
  {#if overflows}
    <Button variant="ghost" size="sm" class="self-start" onclick={toggle}>
      {expanded ? "Show less" : "Show more"}
    </Button>
  {/if}
</div>
