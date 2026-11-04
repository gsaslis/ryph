<script lang="ts">
import { cn } from "$lib/utils";
import CheckIcon from "@lucide/svelte/icons/check";
import { RadioGroup } from "bits-ui";
import type { Snippet } from "svelte";

let {
  value,
  media,
  title,
  meta,
  tint,
  disabled = false,
  wrap = false,
}: {
  /** What picking this card sets the group to. */
  value: string;
  /** The face or icon on the left, about 2rem square. */
  media: Snippet;
  /** The name, on one line. */
  title: Snippet;
  /** One muted line under the name. */
  meta?: Snippet;
  /** The colour the card is washed with from the bottom, as the full cards are; the agent's own
   * for an agent. Defaults to a faint wash of the foreground. */
  tint?: string;
  disabled?: boolean;
  /** Let the name and the detail run onto more lines, for cards that explain themselves. */
  wrap?: boolean;
} = $props();

const wash = $derived(
  tint === undefined
    ? "color-mix(in oklab, var(--foreground) 5%, transparent)"
    : `color-mix(in oklab, ${tint} 15%, transparent)`,
);
</script>

<!-- The small sibling of the cards on the agents and repos pages: the same wash and the same ring,
     with the face, the name and one line of detail in a row. One radio of a `PickGrid`, so the
     arrow keys move between cards and picking one is choosing it. The focus ring is an outline,
     so it shows apart from the ring that marks the picked card. -->
<RadioGroup.Item
  {value}
  {disabled}
  style="--wash: {wash}"
  class={cn(
    "bg-card relative flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg bg-linear-to-t from-(--wash) to-transparent px-3 py-2.5 text-left ring-1 ring-foreground/10 transition-shadow hover:ring-foreground/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none",
    "data-[state=checked]:ring-2 data-[state=checked]:ring-primary",
    "data-disabled:cursor-not-allowed data-disabled:opacity-50 data-disabled:hover:ring-foreground/10",
  )}
>
  {#snippet children({ checked })}
    <span class="flex size-8 shrink-0 items-center justify-center">
      {@render media()}
    </span>
    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class={["text-sm leading-5 font-medium", !wrap && "truncate"]}>{@render title()}</span>
      {#if meta}
        <span class={["text-muted-foreground text-xs", wrap ? "leading-5" : "truncate leading-4"]}>
          {@render meta()}
        </span>
      {/if}
    </span>
    <span
      aria-hidden="true"
      class={[
        "bg-primary text-primary-foreground flex size-4 shrink-0 items-center justify-center self-start rounded-full",
        !checked && "invisible",
      ]}
    >
      <CheckIcon class="size-3" strokeWidth={3} />
    </span>
  {/snippet}
</RadioGroup.Item>
