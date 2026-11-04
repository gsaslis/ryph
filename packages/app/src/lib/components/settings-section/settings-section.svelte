<script lang="ts">
import { cn } from "$lib/utils";
import type { Snippet } from "svelte";

let {
  title,
  description,
  id,
  class: className,
  children,
}: {
  title: string;
  /** One or two sentences: what the setting decides, not how it is implemented. */
  description?: Snippet | string;
  id?: string;
  class?: string;
  children: Snippet;
} = $props();
</script>

<!-- One setting, or one group of them: what it is on the left, the controls on the right. Stacks
     below md, where there is no room for two columns. Sized against the panel (`@container` on the
     app shell), not the viewport, so the tasks pane and the sidebar's fold do not throw it off. -->
<section
  {id}
  aria-labelledby={id ? `${id}-title` : undefined}
  class={cn("grid gap-x-10 gap-y-4 @3xl:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]", className)}
>
  <div class="flex flex-col gap-1">
    <!-- Focusable from script only, so a page can put focus back here when what it was on is
         gone. -->
    <h2
      id={id ? `${id}-title` : undefined}
      tabindex="-1"
      class="text-sm font-semibold outline-none"
    >
      {title}
    </h2>
    {#if typeof description === "string"}
      <p class="text-muted-foreground text-sm text-pretty">{description}</p>
    {:else if description}
      <p class="text-muted-foreground text-sm text-pretty">{@render description()}</p>
    {/if}
  </div>
  <div class="flex min-w-0 flex-col gap-4">
    {@render children()}
  </div>
</section>
