<script lang="ts">
import { cn } from "$lib/utils";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import type { Snippet } from "svelte";

let {
  id,
  name,
  description,
  href,
  newTab = false,
  off = false,
  meta,
  control,
}: {
  /** Names the row's description and meta `{id}-description` and `{id}-meta`, so the control can
   * be described by them as well as named: the meta is often why a switch is off. */
  id?: string;
  name: string;
  description: string;
  /** The skill's own page; absent, the name is plain text. */
  href?: string;
  /** Opens the page in a new tab, for a form that should not be left to read about one skill. */
  newTab?: boolean;
  /** Turned off where this row is shown: the text dims, the row stays readable. */
  off?: boolean;
  /** Small facts beside the name: a version, a warning count, who turned it off. */
  meta?: Snippet;
  /** The switch, or whatever acts on the skill, at the row's end. */
  control?: Snippet;
} = $props();
</script>

<!-- One skill as a row: its name, which is also the folder it lives in, the description the agent
     reads to decide whether to open it, and at the end what can be done about it. Rows stack inside
     a `divide-y rounded-lg border` list, as the permission rows do. The name wraps rather than
     being cut off: it is the skill's only identifier, and two names can share a long start. -->
<div class="flex items-start justify-between gap-6 px-4 py-3">
  <div class={cn("flex min-w-0 flex-col gap-1 transition-opacity", off && "opacity-60")}>
    <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {#if href}
        <a
          {href}
          target={newTab ? "_blank" : undefined}
          rel={newTab ? "noreferrer" : undefined}
          class="focus-visible:ring-ring/50 min-w-0 rounded-sm font-mono text-sm font-medium wrap-anywhere underline-offset-4 outline-none hover:underline focus-visible:ring-[3px]"
        >
          {name}{#if newTab}
            <ExternalLinkIcon
              class="text-muted-foreground ml-1 inline size-3.5 align-[-0.125em]"
              aria-hidden="true"
            /><span class="sr-only">(opens in a new tab)</span>{/if}
        </a>
      {:else}
        <span class="min-w-0 font-mono text-sm font-medium wrap-anywhere">{name}</span>
      {/if}
      {#if meta}
        <span id={id ? `${id}-meta` : undefined} class="contents">{@render meta()}</span>
      {/if}
    </div>
    <p
      id={id ? `${id}-description` : undefined}
      class="text-muted-foreground line-clamp-2 text-xs text-pretty"
      title={description}
    >
      {description}
    </p>
  </div>
  {#if control}
    <div class="flex shrink-0 items-center gap-2 pt-0.5">
      {@render control()}
    </div>
  {/if}
</div>
