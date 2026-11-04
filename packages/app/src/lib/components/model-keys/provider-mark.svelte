<script lang="ts">
import { cn } from "$lib/utils";

let { provider, label, class: className }: { provider: string; label: string; class?: string } =
  $props();
</script>

<!-- A provider's face on its key cards. Lucide carries no brand marks, so the ones drawn here are
     inlined; any other provider — a custom endpoint, say — wears the first letter of its name. -->
<div
  class={cn(
    "bg-background ring-border flex size-12 shrink-0 items-center justify-center rounded-lg ring-1",
    className,
  )}
>
  {#if provider === "anthropic"}
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" class="size-6">
      <path
        d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"
      />
    </svg>
  {:else}
    <span class="text-muted-foreground text-lg font-semibold uppercase" aria-hidden="true">
      {label.trim().charAt(0) || "?"}
    </span>
  {/if}
</div>
