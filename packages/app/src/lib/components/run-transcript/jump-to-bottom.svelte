<script lang="ts">
import { Button } from "$lib/components/ui/button";
import ArrowDownIcon from "@lucide/svelte/icons/arrow-down";
import { cubicOut } from "svelte/easing";
import { prefersReducedMotion } from "svelte/motion";
import { fly } from "svelte/transition";

let {
  onclick,
  label = "Jump to bottom",
  class: className,
}: {
  onclick: () => void;
  label?: string;
  class?: string;
} = $props();
</script>

<div
  class={["pointer-events-auto absolute z-20", className]}
  transition:fly|global={{
    y: prefersReducedMotion.current ? 0 : 8,
    duration: prefersReducedMotion.current ? 0 : 160,
    easing: cubicOut,
  }}
>
  <Button
    variant="secondary"
    size="sm"
    class="h-7 gap-1 rounded-full px-3 text-xs shadow-md"
    {onclick}
  >
    <ArrowDownIcon data-icon="inline-start" />
    {label}
  </Button>
</div>
