<script lang="ts">
import AppWindowIcon from "@lucide/svelte/icons/app-window";
import { cn } from "$lib/utils";
import { ensureFreshSession } from "$lib/utils/auth/auth";
import { artifactThumbnailHref, ThumbnailState } from "./thumbnail-state.svelte";
import { lazyThumbnail } from "./lazy-thumbnail";

let { id, version, title, class: className }: {
  id: string;
  version: number;
  title: string;
  class?: string;
} = $props();

const src = $derived(artifactThumbnailHref(id, version));
// A new version gets a fresh state; late events from its predecessor cannot change it.
const image = $derived(new ThumbnailState(src));
</script>

<div class={cn("bg-muted relative isolate overflow-hidden", className)}>
  {#key image}
    {@const thumbnail = image}
    {#if !thumbnail.loaded}
      <div class="text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-2">
        <AppWindowIcon class="size-6" aria-hidden="true" />
        <span class="text-xs">{thumbnail.failed ? "Preview unavailable" : "Preview"}</span>
      </div>
    {/if}
    {#if !thumbnail.failed}
      <img
        {@attach lazyThumbnail(thumbnail, ensureFreshSession)}
        alt={title}
        loading="lazy"
        decoding="async"
        class={cn("pointer-events-none absolute inset-0 size-full object-cover object-top", !thumbnail.loaded && "opacity-0")}
      />
    {/if}
  {/key}
</div>
