<script lang="ts">
import type { ThinkingLevel } from "$lib/api/types";
import * as Field from "$lib/components/ui/field";
import * as Select from "$lib/components/ui/select";
import { cn } from "$lib/utils";
import { THINKING_LABELS, thinkingInvalid } from "./thinking";

// One thinking level, or the default. A level the model does not list stays picked and is marked
// invalid rather than dropped: the server clamps it, so the person decides whether to change it.
let {
  value = $bindable(),
  levels,
  id,
  emptyLabel,
}: {
  /** null is the default. */
  value: ThinkingLevel | null;
  /** The levels the model takes, least to most. */
  levels: readonly ThinkingLevel[];
  id?: string;
  /** The default's label, e.g. "Agent default (Medium)". */
  emptyLabel: string;
} = $props();

const EMPTY = "::empty";

const invalid = $derived(thinkingInvalid(value, levels));
</script>

<div class="flex flex-col gap-2">
  <Select.Root
    type="single"
    value={value ?? EMPTY}
    onValueChange={(next) => {
      value = next === EMPTY ? null : (next as ThinkingLevel);
    }}
  >
    <Select.Trigger {id} class="w-full" aria-invalid={invalid}>
      <span class={cn("truncate", value === null && "text-muted-foreground")}>
        {value === null ? emptyLabel : THINKING_LABELS[value]}
      </span>
    </Select.Trigger>
    <Select.Content>
      <Select.Group>
        <Select.Item value={EMPTY} label={emptyLabel} />
      </Select.Group>
      <Select.Separator />
      <Select.Group>
        {#each levels as level (level)}
          <Select.Item value={level} label={THINKING_LABELS[level]} />
        {/each}
      </Select.Group>
    </Select.Content>
  </Select.Root>
  {#if invalid}
    <Field.FieldError>This model doesn't take this level.</Field.FieldError>
  {/if}
</div>
