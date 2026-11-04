<script lang="ts">
import { pageHeader } from "$lib/components/page-header/page-header.svelte";
import type { Snippet } from "svelte";
import type { Attachment } from "svelte/attachments";

let {
  title,
  aside,
  description,
  actions,
}: {
  title: string;
  /** Beside the title, in its line: what tells this one apart from others of its name. */
  aside?: Snippet;
  description?: Snippet | string;
  /** The page's main action, or a control over what it shows. */
  actions?: Snippet;
} = $props();

// Handed to the bar above, which brings itself in as this scrolls under it. Cleared only while
// still this one: the next page's title may already be in place when this one is torn down.
const handToHeader: Attachment<HTMLElement> = (el) => {
  pageHeader.title = el;
  return () => {
    if (pageHeader.title === el) pageHeader.title = null;
  };
};
</script>

<!-- The head of a list or settings page. The actions sit on the title's line, so the description
     below gets the page's whole width instead of a column squeezed beside a button; when the line
     is too narrow for both, the actions wrap under the title rather than crushing it. -->
<div class="flex flex-col gap-1">
  <div class="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-3">
    <div class="flex min-w-0 items-baseline gap-x-3">
      <h1
        class="font-heading text-[28px] leading-tight font-bold tracking-[-0.02em]"
        {@attach handToHeader}
      >
        {title}
      </h1>
      {#if aside}
        {@render aside()}
      {/if}
    </div>
    {#if actions}
      <div class="flex items-center gap-2">
        {@render actions()}
      </div>
    {/if}
  </div>
  {#if typeof description === "string"}
    <p class="text-muted-foreground text-sm">{description}</p>
  {:else if description}
    <p class="text-muted-foreground text-sm">{@render description()}</p>
  {/if}
</div>
