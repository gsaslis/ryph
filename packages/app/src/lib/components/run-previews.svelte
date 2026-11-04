<script lang="ts">
import { Button } from "$lib/components/ui/button";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import type { RunPreview } from "$lib/api/previews";
import { isLocalPreviewUrl } from "$lib/utils/previews";

let { previews, available = true, href }: {
  previews: RunPreview[];
  available?: boolean;
  /** Where a preview's open action goes: the app's route that lets the viewer in. */
  href: (preview: RunPreview) => string | undefined;
} = $props();

const local = $derived(previews.every((preview) => isLocalPreviewUrl(preview.url)));
</script>

{#if previews.length > 0}
  <section class="shrink-0 border-b px-4 py-4" aria-label="Dev server previews">
  <div class="mb-3 flex items-center justify-between gap-2">
    <h3 class="flex items-center gap-2 text-xs font-medium">
      Previews <span class="text-muted-foreground tabular-nums">{previews.length}</span>
    </h3>
    <span class="text-muted-foreground text-xs">
      {local ? "This machine only" : "People who can see this run"}
    </span>
  </div>
  <ul class="flex max-h-48 flex-col gap-3 overflow-y-auto">
    {#each previews as preview (preview.id)}
      <li class="flex items-center gap-3">
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <bdi class="truncate text-sm font-medium">{preview.label}</bdi>
          <span class="text-muted-foreground font-mono text-xs">Port {preview.port}</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          href={available ? href(preview) : undefined}
          disabled={!available}
          title={available ? undefined : "Preview discovery unavailable. Retrying…"}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${preview.label} preview`}
        >
          Open preview <ExternalLinkIcon data-icon="inline-end" />
        </Button>
      </li>
    {/each}
  </ul>
</section>
{/if}
