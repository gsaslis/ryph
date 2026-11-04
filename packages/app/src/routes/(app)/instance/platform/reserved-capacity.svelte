<script lang="ts">
/**
 * Slots held per size class, so a run or check of that size starts on a machine that is already
 * there instead of waiting for one to be made.
 *
 * WHY THE STATUS READS THE SAVED NUMBER. The badge compares what the cluster holds with what was
 * saved, not with what is typed: a half-edited field says nothing about the cluster yet. After a
 * save the ready count lags for as long as new machines take to come up, and "1 of 2 ready" is
 * the honest answer meanwhile.
 */
import { invalidate } from "$app/navigation";
import { putReservedCapacity } from "$lib/api/reserved-capacity";
import type { ReservedCapacity } from "$lib/api/types";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Spinner } from "$lib/components/ui/spinner";
import { formatDateTime } from "$lib/utils/format";
import { sizeSummary } from "$lib/utils/run-sizes";
import { toast } from "svelte-sonner";
import { untrack } from "svelte";

let { capacity }: { capacity: ReservedCapacity } = $props();

type Row = ReservedCapacity["classes"][number];

// Seeded once, then the admin's to edit. `untrack` because the reload after a save must not
// reach in and rewrite a number somebody is part-way through typing. A number input binds to
// null while it is empty.
let slots = $state<Record<string, number | null>>(
  untrack(() => Object.fromEntries(capacity.classes.map((c) => [c.name, c.slots]))),
);
let saving = $state(false);

const valid = (value: number | null) =>
  value !== null && Number.isInteger(value) && value >= 0 && value <= capacity.maxSlots;

const invalid = $derived(
  capacity.classes.filter((c) => c.reservable && !valid(slots[c.name] ?? null)).map((c) => c.name),
);
const changed = $derived(capacity.classes.some((c) => (slots[c.name] ?? 0) !== c.slots));

// What one slot holds: the class, and room for the services a run of it may add.
function holds(row: Row): string {
  if (!row.reservable) return "Can't be reserved";
  if (row.services === 0) return sizeSummary(row);
  return `${sizeSummary(row)}, plus room for ${row.services} ${
    row.services === 1 ? "service" : "services"
  }`;
}

function status(row: Row): string | null {
  if (row.slots === 0) return null;
  if (row.ready === null) return "Status unknown";
  if (row.ready >= row.slots) return "Ready";
  return `${row.ready} of ${row.slots} ready`;
}

async function save(event: SubmitEvent) {
  event.preventDefault();
  if (invalid.length > 0) {
    toast.error(`Slots must be whole numbers from 0 to ${capacity.maxSlots}`);
    return;
  }
  saving = true;
  try {
    await putReservedCapacity(
      Object.fromEntries(
        capacity.classes
          .filter((c) => c.reservable && (slots[c.name] ?? 0) > 0)
          .map((c) => [c.name, slots[c.name] ?? 0]),
      ),
    );
    toast.success("Reserved capacity saved");
    await invalidate("app:platform");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to save reserved capacity");
  } finally {
    saving = false;
  }
}
</script>

<div>
  {#if !capacity.supported}
    <p class="text-muted-foreground text-sm">Not available on this deployment.</p>
  {:else}
    <form class="flex flex-col gap-6" onsubmit={save}>
      <Field.FieldGroup>
        {#each capacity.classes as row (row.name)}
          {@const label = status(row)}
          {@const bad = invalid.includes(row.name)}
          <Field.Field
            orientation="horizontal"
            data-invalid={bad || undefined}
            data-disabled={!row.reservable || undefined}
          >
            <Field.FieldContent>
              <div class="flex flex-wrap items-center gap-2">
                <Field.FieldLabel for="reserved-{row.name}">{row.name}</Field.FieldLabel>
                {#if label !== null}
                  <Badge variant={label === "Ready" ? "secondary" : "outline"}>{label}</Badge>
                {/if}
              </div>
              <Field.FieldDescription>{holds(row)}</Field.FieldDescription>
            </Field.FieldContent>
            <Input
              id="reserved-{row.name}"
              class="w-20 shrink-0"
              type="number"
              min={0}
              max={capacity.maxSlots}
              step={1}
              disabled={!row.reservable || saving}
              aria-invalid={bad || undefined}
              bind:value={slots[row.name]}
            />
          </Field.Field>
        {/each}
      </Field.FieldGroup>

      <div class="flex items-center justify-between gap-4">
        <span class="text-muted-foreground text-xs">
          {#if capacity.updatedAt}
            Last changed {formatDateTime(capacity.updatedAt)}.
          {/if}
        </span>
        <Button type="submit" disabled={saving || !changed}>
          {#if saving}
            <Spinner data-icon="inline-start" />
          {/if}
          Save
        </Button>
      </div>
    </form>
  {/if}
</div>
