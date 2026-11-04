<script lang="ts">
import * as InputGroup from "$lib/components/ui/input-group";
import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
import ChevronUpIcon from "@lucide/svelte/icons/chevron-up";
import SearchIcon from "@lucide/svelte/icons/search";
import type { LogFind } from "./log-find.svelte";

let { find, disabled = false }: { find: LogFind; disabled?: boolean } = $props();

// The input belongs to the bar, not to the find: a page that starts the find over (another suite,
// another build) keeps the bar mounted, and `bind:ref` is written only when the input mounts.
let input = $state<HTMLInputElement | null>(null);

// The browser's own find sees only the rows on screen: in a log, the find bar takes its keys.
// Only the plain shortcut, and only once there is a log to search.
function onWindowKey(e: KeyboardEvent) {
  const plain = e.metaKey !== e.ctrlKey && !e.shiftKey && !e.altKey;
  if (plain && e.key.toLowerCase() === "f" && input !== null && !input.disabled) {
    e.preventDefault();
    input.focus();
    input.select();
  }
}
</script>

<svelte:window onkeydown={onWindowKey} />

<InputGroup.Root class="mr-2 h-8 w-60" role="search">
  <InputGroup.Addon>
    <SearchIcon />
  </InputGroup.Addon>
  <InputGroup.Input
    bind:ref={input}
    bind:value={find.query}
    oninput={() => (find.index = 0)}
    onkeydown={(e) => find.onKey(e)}
    {disabled}
    placeholder="Find in log"
    aria-label="Find in log"
  />
  {#if find.query !== ""}
    <InputGroup.Addon align="inline-end">
      <span class="text-xs tabular-nums" aria-live="polite">{find.label}</span>
      <InputGroup.Button
        size="icon-xs"
        aria-label="Previous match"
        title="Previous match"
        disabled={find.matches.length === 0}
        onclick={() => find.step(-1)}
      >
        <ChevronUpIcon />
      </InputGroup.Button>
      <InputGroup.Button
        size="icon-xs"
        aria-label="Next match"
        title="Next match"
        disabled={find.matches.length === 0}
        onclick={() => find.step(1)}
      >
        <ChevronDownIcon />
      </InputGroup.Button>
    </InputGroup.Addon>
  {/if}
</InputGroup.Root>
