<script lang="ts" generics="T">
import { Button } from "$lib/components/ui/button";
import * as InputGroup from "$lib/components/ui/input-group";
import SearchIcon from "@lucide/svelte/icons/search";
import { RadioGroup } from "bits-ui";
import type { Snippet } from "svelte";
import { PICK_SHOW_WHOLE, pickSearchable, pickWindow } from "./pick-list";

let {
  items,
  key,
  text,
  value,
  onValueChange,
  label,
  searchLabel,
  card,
}: {
  items: readonly T[];
  key: (item: T) => string;
  /** What a search matches against. */
  text: (item: T) => string;
  /** The picked item's key; "" for none. */
  value: string;
  onValueChange: (value: string) => void;
  /** The group's name, for a screen reader. */
  label: string;
  /** The search box's placeholder, shown on a long list. */
  searchLabel: string;
  /** One `PickCard` for an item. */
  card: Snippet<[T]>;
} = $props();

let query = $state("");
let expanded = $state(false);

const view = $derived(pickWindow(items, { key, text, query, expanded, selected: value }));
const searchable = $derived(pickSearchable(items.length));
const foldable = $derived(query.trim() === "" && items.length > PICK_SHOW_WHOLE);
</script>

<!-- Cards in a grid, as one radio group: the arrow keys move between them, picking as they go.
     The columns follow the room the grid has, not the window, so it reads the same beside an open
     sidebar. A long list shows its first few with a search and a way to see the rest. -->
<div class="@container flex flex-col gap-3">
  {#if searchable}
    <InputGroup.Root class="h-8">
      <InputGroup.Addon>
        <SearchIcon />
      </InputGroup.Addon>
      <InputGroup.Input
        bind:value={query}
        placeholder={searchLabel}
        aria-label={searchLabel}
        autocomplete="off"
        spellcheck={false}
      />
    </InputGroup.Root>
  {/if}
  <RadioGroup.Root
    {value}
    {onValueChange}
    aria-label={label}
    class="grid grid-cols-1 gap-2 @sm:grid-cols-2 @xl:grid-cols-3"
  >
    {#each view.shown as item (key(item))}
      {@render card(item)}
    {/each}
  </RadioGroup.Root>
  {#if view.shown.length === 0}
    <p class="text-muted-foreground px-1 text-sm">Nothing matches "{query.trim()}".</p>
  {/if}
  {#if foldable}
    <Button
      variant="ghost"
      size="sm"
      class="text-muted-foreground self-center"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
    >
      {expanded ? "Show fewer" : `Show all ${items.length}`}
    </Button>
  {/if}
</div>
