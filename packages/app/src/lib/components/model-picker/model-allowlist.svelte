<script lang="ts">
import type { DeclaredModel } from "$lib/api/types";
import { Badge } from "$lib/components/ui/badge";
import * as Command from "$lib/components/ui/command";
import * as Popover from "$lib/components/ui/popover";
import * as ToggleGroup from "$lib/components/ui/toggle-group";
import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
import PlusIcon from "@lucide/svelte/icons/plus";
import XIcon from "@lucide/svelte/icons/x";
import { priceHint, priceLabel } from "./models";

// Which models something may call: any, or a list. The list shows as chips; the popover searches
// the known models, and an id it does not know can be added from the search box. An empty list
// is left empty rather than read as "any", so the form can say it needs at least one.
let {
  allowed = $bindable(),
  models,
  id,
}: {
  allowed: "*" | string[];
  models: DeclaredModel[];
  /** Lands on the mode toggle, which is what a field label names. */
  id?: string;
} = $props();

const ADD = "::add";

let open = $state(false);
let search = $state("");
// The last list, so flipping to "Any model" and back does not lose it.
let remembered: string[] = [];

const mode = $derived(allowed === "*" ? "any" : "only");
const known = $derived(new Map(models.map((m) => [m.id, m])));
const list = $derived(allowed === "*" ? [] : [...new Set(allowed)]);
const customIds = $derived(list.filter((m) => !known.has(m)));
const typed = $derived(search.trim());
const canAdd = $derived(typed !== "" && !known.has(typed) && !list.includes(typed));

// Ids are matched as text, not fuzzily: "haiku" should find claude-haiku-4-5 and nothing else.
// "Add" always shows while offered but ranks last, so Enter picks a real match when there is one.
function filter(value: string, query: string, keywords?: string[]): number {
  if (value === ADD) return 0.01;
  const q = query.trim().toLowerCase();
  return [value, ...(keywords ?? [])].some((v) => v.toLowerCase().includes(q)) ? 1 : 0;
}

function setMode(next: string) {
  if (next === "any" && allowed !== "*") {
    remembered = allowed;
    allowed = "*";
  } else if (next === "only" && allowed === "*") {
    allowed = remembered;
  }
}

function toggle(model: string) {
  allowed = list.includes(model) ? list.filter((m) => m !== model) : [...list, model];
}

function add(model: string) {
  allowed = [...list, model];
  search = "";
}

function stop(event: Event) {
  event.stopPropagation();
}
</script>

<div class="flex flex-col gap-2">
  <!-- Clicking the pressed item would unpress it; the getter puts it back. -->
  <ToggleGroup.Root
    type="single"
    variant="outline"
    bind:value={() => mode, (next) => next && setMode(next)}
    class="w-fit"
  >
    <ToggleGroup.Item {id} value="any">Any model</ToggleGroup.Item>
    <ToggleGroup.Item value="only">Only these</ToggleGroup.Item>
  </ToggleGroup.Root>
  {#if allowed !== "*"}
    <Popover.Root bind:open>
      <Popover.Trigger>
        {#snippet child({ props })}
          <div
            {...props}
            role="combobox"
            aria-expanded={open}
            aria-label="Allowed models"
            tabindex="0"
            class="border-input dark:bg-input/30 dark:hover:bg-input/50 focus-visible:border-ring focus-visible:ring-ring/50 flex min-h-9 w-full cursor-pointer flex-wrap items-center gap-1.5 rounded-md border bg-transparent py-1.5 pr-2 pl-2 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-3"
          >
            {#each list as model (model)}
              <Badge variant="secondary" class="gap-1 pr-1 font-normal">
                {known.get(model)?.label ?? model}
                <button
                  type="button"
                  class="hover:bg-foreground/10 focus-visible:ring-ring/50 -my-0.5 flex size-4 cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:ring-2"
                  aria-label="Remove {model}"
                  onpointerdown={stop}
                  onkeydown={stop}
                  onclick={(event) => {
                    stop(event);
                    toggle(model);
                  }}
                >
                  <XIcon class="size-3" />
                </button>
              </Badge>
            {:else}
              <span class="text-muted-foreground px-0.5">Pick models</span>
            {/each}
            <ChevronDownIcon class="text-muted-foreground pointer-events-none ml-auto size-4 shrink-0" />
          </div>
        {/snippet}
      </Popover.Trigger>
      <Popover.Content class="w-(--bits-popover-anchor-width) min-w-64 p-0" align="start">
        <Command.Root {filter}>
          <Command.Input
            bind:value={search}
            placeholder={models.length > 0 ? "Search, or type a model id" : "Type a model id"}
          />
          <Command.List>
            <Command.Empty>
              {models.length > 0 ? "No model matches." : "Type a model id to add it."}
            </Command.Empty>
            {#if models.length > 0}
              <Command.Group heading="Models">
                {#each models as model (model.id)}
                  {@const price = priceLabel(model)}
                  <Command.Item
                    value={model.id}
                    keywords={model.label ? [model.label] : undefined}
                    data-checked={list.includes(model.id)}
                    onSelect={() => toggle(model.id)}
                  >
                    <span class="flex-1 truncate">{model.label ?? model.id}</span>
                    {#if price}
                      <span class="text-muted-foreground text-xs tabular-nums" title={priceHint(model)}>
                        {price}
                      </span>
                    {/if}
                  </Command.Item>
                {/each}
              </Command.Group>
            {/if}
            {#if customIds.length > 0}
              <Command.Group heading="Custom">
                {#each customIds as model (model)}
                  <Command.Item value={model} data-checked onSelect={() => toggle(model)}>
                    <span class="flex-1 truncate">{model}</span>
                  </Command.Item>
                {/each}
              </Command.Group>
            {/if}
            {#if canAdd}
              <Command.Group>
                <Command.Item value={ADD} onSelect={() => add(typed)}>
                  <PlusIcon />
                  <span class="flex-1 truncate">Add "{typed}"</span>
                </Command.Item>
              </Command.Group>
            {/if}
          </Command.List>
        </Command.Root>
      </Popover.Content>
    </Popover.Root>
  {/if}
</div>
