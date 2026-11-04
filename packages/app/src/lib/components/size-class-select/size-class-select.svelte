<script lang="ts">
import type { RunSize } from "$lib/api/types";
import * as Select from "$lib/components/ui/select";
import { DEFAULT_SIZE_VALUE, sizeClassLabel, sizeSummary } from "$lib/utils/run-sizes";

let {
  value,
  sizes,
  canChange,
  onChange,
  id,
}: {
  /** The subject's stored class; null is the deployment's default. */
  value: string | null;
  /** What the deployment offers, or null when that could not be read. */
  sizes: RunSize[] | null;
  /** Admins only: the API refuses everyone else, so nobody else is offered the control. */
  canChange: boolean;
  /** Called with the new class, or null for the default. Only on an actual change. */
  onChange: (sizeClass: string | null) => void;
  id?: string;
} = $props();

const label = $derived(sizes === null ? (value ?? "Default") : sizeClassLabel(value, sizes));
const current = $derived(
  sizes?.find((s) => s.name === value) ?? sizes?.find((s) => s.default && value === null) ?? null,
);

function pick(next: string) {
  const sizeClass = next === DEFAULT_SIZE_VALUE ? null : next;
  if (sizeClass !== value) onChange(sizeClass);
}
</script>

<div class="flex flex-col gap-2">
  {#if canChange && sizes !== null}
    <Select.Root type="single" value={value ?? DEFAULT_SIZE_VALUE} onValueChange={pick}>
      <Select.Trigger {id} class="w-full sm:w-96" aria-label="Size class">{label}</Select.Trigger>
      <Select.Content>
        <Select.Group>
          <Select.Item value={DEFAULT_SIZE_VALUE} label={sizeClassLabel(null, sizes)} />
          {#each sizes as size (size.name)}
            <Select.Item value={size.name} label={size.name}>
              <span class="flex flex-col">
                <span>{size.name}</span>
                <span class="text-muted-foreground text-xs">{sizeSummary(size)}</span>
              </span>
            </Select.Item>
          {/each}
        </Select.Group>
      </Select.Content>
    </Select.Root>
  {:else}
    <p class="text-sm font-medium">{label}</p>
  {/if}
  <p class="text-muted-foreground text-sm">
    {#if current}
      {sizeSummary(current)}.
    {/if}
    {#if sizes === null}
      The size classes could not be read right now.
    {:else if !canChange}
      Only an administrator can change this — it spends the operator's compute.
    {/if}
  </p>
</div>
