<script lang="ts">
import { tick } from "svelte";
import type { DeclaredModel } from "$lib/api/types";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select";
import { cn } from "$lib/utils";
import { priceHint, priceLabel } from "./models";

// One model, picked from a list with a way out: "Custom model" swaps in a text field for an id
// the list does not know. An id that is already set and not in the list opens on that field, so
// a stored value is always shown as it is. Where the list is all there is (`allowCustom` off), a
// value outside it is marked invalid rather than shown as if it were a fine pick.
let {
  value = $bindable(),
  models,
  id,
  emptyLabel,
  allowCustom = true,
  required = false,
  class: className,
}: {
  value: string;
  models: DeclaredModel[];
  id?: string;
  /** Offers "" as a choice under this label, e.g. "Agent default". */
  emptyLabel?: string;
  /** False keeps the choice to the list, for a pick bounded by an allowlist. */
  allowCustom?: boolean;
  required?: boolean;
  class?: string;
} = $props();

const EMPTY = "::empty";
const CUSTOM = "::custom";

// "Custom model" chosen with nothing typed yet. Written by `choose`, and dropped whenever
// `allowCustom` changes, so a field that may no longer take a typed id does not keep offering one.
let customPicked = $derived.by(() => {
  void allowCustom;
  return false;
});
let input = $state<HTMLInputElement | null>(null);

// Keyed by id, so an allowlist stored with an id twice still lists it once.
const known = $derived(new Map(models.map((m) => [m.id, m])));
const unknown = $derived(value !== "" && !known.has(value));
const custom = $derived(allowCustom && (customPicked || unknown));
const invalid = $derived(!allowCustom && unknown);
const selected = $derived(custom ? CUSTOM : value === "" ? EMPTY : value);
const triggerLabel = $derived.by(() => {
  if (custom) return "Custom model";
  if (value === "") return emptyLabel ?? "Select a model";
  return known.get(value)?.label ?? value;
});

async function choose(next: string) {
  if (next === CUSTOM) {
    customPicked = true;
    if (known.has(value)) value = "";
    await tick();
    input?.focus();
    return;
  }
  customPicked = false;
  value = next === EMPTY ? "" : next;
}
</script>

{#if known.size === 0 && allowCustom}
  <!-- Nothing to pick from, so the id is typed. -->
  <Input
  {id}
  class={className}
  bind:value
  {required}
  placeholder={emptyLabel ?? "Model id"}
  autocomplete="off"
/>
{:else}
  <div class={cn("flex flex-col gap-2", className)}>
    <Select.Root type="single" value={selected} onValueChange={choose}>
      <Select.Trigger {id} class="w-full" aria-invalid={invalid}>
        <span class={cn("truncate", value === "" && !custom && "text-muted-foreground")}>
          {triggerLabel}
        </span>
      </Select.Trigger>
      <Select.Content>
        {#if emptyLabel !== undefined}
          <Select.Group>
            <Select.Item value={EMPTY} label={emptyLabel} />
          </Select.Group>
          <Select.Separator />
        {/if}
        <Select.Group>
          {#each known.values() as model (model.id)}
            {@const price = priceLabel(model)}
            <Select.Item value={model.id} label={model.label ?? model.id}>
              <span class="truncate">{model.label ?? model.id}</span>
              {#if price}
                <span
                  class="text-muted-foreground ml-auto pl-4 text-xs tabular-nums"
                  title={priceHint(model)}
                >
                  {price}
                </span>
              {/if}
            </Select.Item>
          {/each}
        </Select.Group>
        {#if allowCustom}
          <Select.Separator />
          <Select.Group>
            <Select.Item value={CUSTOM} label="Custom model…" />
          </Select.Group>
        {/if}
      </Select.Content>
    </Select.Root>
    {#if custom}
      <Input
        bind:ref={input}
        bind:value
        {required}
        aria-label="Custom model id"
        placeholder="Model id"
        autocomplete="off"
      />
    {/if}
    {#if invalid}
      <Field.FieldError>Not one of the allowed models.</Field.FieldError>
    {/if}
  </div>
{/if}
