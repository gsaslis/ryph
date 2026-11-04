<script lang="ts">
import type { Snippet } from "svelte";

let {
  title,
  icon,
  mark,
  badge,
  actions,
  children,
}: {
  title: string;
  /** The mark in the tile: sized by the tile, so pass it without a size class. */
  icon?: Snippet;
  /** A mark that draws its own tile, in place of `icon` in the standard one. Sized
   * `size-11 rounded-lg @2xl:size-14 @2xl:rounded-xl` to match. */
  mark?: Snippet;
  /** Sits beside the title, wrapping under it when there is no room. */
  badge?: Snippet;
  actions?: Snippet;
  /** The lines under the title. */
  children?: Snippet;
} = $props();
</script>

<!-- The head of a page about one thing: its mark, its name, a line or two about it, and what you
     can do to it. On a narrow panel the actions drop to their own row under everything instead of
     squeezing the title down to a couple of letters; sized against the panel (`@container` on the
     app shell), not the viewport. -->
<header
  class="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-4 @2xl:grid-cols-[auto_minmax(0,1fr)_auto]"
>
  {#if mark}
    {@render mark()}
  {:else}
  <div
    class="bg-background ring-border text-muted-foreground flex size-11 shrink-0 items-center justify-center rounded-lg ring-1 @2xl:size-14 @2xl:rounded-xl [&_svg]:size-5.5 @2xl:[&_svg]:size-7"
  >
    {@render icon?.()}
  </div>
  {/if}
  <div class="flex min-w-0 flex-col gap-1.5 @max-2xl:min-h-11 @max-2xl:justify-center">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <h1 class="font-heading text-2xl leading-tight font-bold tracking-[-0.02em] text-balance break-words @2xl:text-[28px]">
        {title}
      </h1>
      {@render badge?.()}
    </div>
    {@render children?.()}
  </div>
  {#if actions}
    <div class="col-span-full flex flex-wrap items-center gap-2 @2xl:col-span-1">
      {@render actions()}
    </div>
  {/if}
</header>
