<script lang="ts">
import type { ForgeProvider } from "$lib/api/types";
import { cn } from "$lib/utils";
import LaptopIcon from "@lucide/svelte/icons/laptop";
import SproutIcon from "@lucide/svelte/icons/sprout";

let { provider, class: className }: { provider: ForgeProvider; class?: string } = $props();
</script>

<!-- Lucide dropped its brand marks, so GitHub's is inlined (Octicons' mark-github). Radicle has
     no mark of its own that reads at this size; the seedling is the one its own tooling uses. A
     local repo lives on the machine Ryph runs on, so it gets a laptop. GitLab gets a plain
     tanuki outline, so it never falls through to Radicle's seedling. -->
{#if provider === "github"}
  <svg
  viewBox="0 0 16 16"
  fill="currentColor"
  aria-hidden="true"
  class={cn("size-4 shrink-0", className)}
>
  <path
    d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
  />
</svg>
{:else if provider === "gitlab"}
  <svg
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  class={cn("size-4 shrink-0", className)}
>
  <path
    d="M12 21 2.3 13.9a.7.7 0 0 1-.3-.8L5.4 3.3a.4.4 0 0 1 .7 0L8.3 10h7.4l2.2-6.7a.4.4 0 0 1 .7 0L22 13.1a.7.7 0 0 1-.3.8Z" />
</svg>
{:else if provider === "local"}
  <LaptopIcon aria-hidden="true" class={cn("size-4 shrink-0", className)} />
{:else}
  <SproutIcon aria-hidden="true" class={cn("size-4 shrink-0", className)} />
{/if}
