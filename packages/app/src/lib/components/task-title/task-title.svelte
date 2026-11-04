<script lang="ts">
import { cubicOut } from "svelte/easing";
import { prefersReducedMotion } from "svelte/motion";
import { fade, fly } from "svelte/transition";
import { cn } from "$lib/utils";
import { AWAITING_PROMPT_LABEL } from "$lib/utils/task-prompt";

let { title, compact = false }: { title: string | null; compact?: boolean } = $props();
let height = $state<number>();
const textClass = $derived(cn(
  compact && "line-clamp-2",
  title === null ? "text-muted-foreground italic font-normal" : "font-medium",
));
</script>

<!-- Measure only the incoming title, never the outgoing transition. Keeping the measuring
     copy in flow also gives the first render its natural height, without an entrance jump. -->
<span
  class="relative block overflow-hidden transition-[height] duration-[370ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
  style:height={height === undefined ? undefined : `${height}px`}
>
  <span class="sr-only">{title ?? AWAITING_PROMPT_LABEL}</span>
  <span aria-hidden="true" class={cn("invisible block", textClass)} bind:clientHeight={height}>
    {title ?? AWAITING_PROMPT_LABEL}
  </span>
  {#key title}
    <span
      aria-hidden="true"
      class={cn(
        "absolute inset-x-0 top-0 block min-w-0",
        textClass,
      )}
      in:fly={{
        y: prefersReducedMotion.current ? 0 : 5,
        duration: prefersReducedMotion.current ? 0 : 280,
        delay: prefersReducedMotion.current ? 0 : 90,
        easing: cubicOut,
      }}
      out:fade={{ duration: prefersReducedMotion.current ? 0 : 120 }}
    >
      {title ?? AWAITING_PROMPT_LABEL}
    </span>
  {/key}
</span>
