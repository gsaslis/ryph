<script lang="ts">
import { Button } from "$lib/components/ui/button";
import type { Snippet } from "svelte";

// One step's part of a review: its name, the way back to it, and — when the step cannot be
// saved as it stands — the reason, in red, before what the step holds.
let {
  label,
  problem = null,
  onchange,
  children,
}: {
  label: string;
  /** Why the step cannot be saved, or null. */
  problem?: string | null;
  /** Asked to go back to the step. */
  onchange: () => void;
  children: Snippet;
} = $props();
</script>

<section class="flex flex-col gap-2">
  <div class="flex flex-col gap-1">
    <div class="flex items-center justify-between gap-4">
      <h2 class="text-base font-medium">{label}</h2>
      <Button variant="ghost" size="sm" type="button" onclick={onchange}>Change</Button>
    </div>
    {#if problem}
      <p class="text-destructive text-sm">{problem}</p>
    {/if}
  </div>
  {@render children()}
</section>
