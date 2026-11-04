<script lang="ts" generics="T">
import type { Snippet } from "svelte";
import { fade } from "svelte/transition";
import type { RailFlyout } from "./flyout-state.svelte";

let { flyout, children }: { flyout: RailFlyout<T>; children: Snippet<[T]> } = $props();

// The content's own size, so the card's can animate to it: `auto` does not transition. The
// content is `w-max`, so it measures at its natural width whatever the card is doing.
let contentHeight = $state(0);
let contentWidth = $state(0);
</script>

<!-- Fixed to the viewport beside the rail. Position and height animate between rows; opacity and
     scale animate on open and close. The frame it appears on skips the position transition, so it
     appears at the row rather than sliding over from where it last closed. Named for view
     transitions so a navigation from the rail leaves it where it is instead of sliding it away
     with the old page. -->
{#if flyout.current !== null}
  {@const item = flyout.current}
  <div
  role="presentation"
  class={[
      "bg-popover text-popover-foreground ring-foreground/10 fixed top-0 z-50 origin-left overflow-hidden rounded-xl shadow-lg ring-1 ease-out motion-reduce:transition-none [view-transition-name:rail-flyout]",
      flyout.instant
        ? "transition-[opacity,scale] duration-150"
        : "transition-[translate,width,height,opacity,scale] duration-200",
      flyout.open ? "scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0",
    ]}
  style:left="{flyout.left}px"
  style:translate="0 {flyout.top - 4}px"
  style:height={contentHeight ? `${contentHeight}px` : undefined}
  style:width={contentWidth ? `${contentWidth}px` : undefined}
  onpointerenter={() => flyout.keep()}
  onpointerleave={() => flyout.hideSoon()}
  onfocusin={() => flyout.keep()}
  onfocusout={() => flyout.hideSoon()}
>
  <div class="w-max" bind:clientHeight={contentHeight} bind:clientWidth={contentWidth}>
      <!-- Keyed by item, so moving to another row fades the new content in while the card
           glides; the old content is simply replaced, which the fade hides. -->
      {#key item}
        <div in:fade={{ duration: 150 }}>
          {@render children(item)}
        </div>
      {/key}
    </div>
</div>
{/if}
