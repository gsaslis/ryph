<script lang="ts">
import * as Collapsible from "$lib/components/ui/collapsible";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Label } from "$lib/components/ui/label";
import { Switch } from "$lib/components/ui/switch";
import { DEFAULT_MEMORY_BUDGET_TOKENS } from "$lib/api/types";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";

let {
  remembers = $bindable(),
  memoryBudget = $bindable(),
  memoryAgentOnly = $bindable(),
}: {
  /** Whether the agent starts each run with a memory brief and holds the memory tools. */
  remembers: boolean;
  /** The brief's token budget, as typed. */
  memoryBudget: string;
  memoryAgentOnly: boolean;
} = $props();

// The budget is a tuning knob with a sensible default, so it starts folded; an editor who set
// one sees it open, since a hidden non-default would read as "the default".
// svelte-ignore state_referenced_locally
let advancedOpen = $state(
  memoryAgentOnly || memoryBudget.trim() !== String(DEFAULT_MEMORY_BUDGET_TOKENS),
);
</script>

<Field.FieldSet>
  <Field.FieldLegend>Memory</Field.FieldLegend>
  <Field.FieldDescription>
    When memory is enabled, the agent is briefed with memories from previous runs, may propose new or refute
    memories, and search the memory canon in natural language.
  </Field.FieldDescription>
  <Field.FieldGroup>
    <div class="flex items-center gap-3">
      <Switch id="remembers" bind:checked={remembers} />
      <Label for="remembers">Enable memory for this agent</Label>
    </div>
    {#if remembers}
      <Collapsible.Root bind:open={advancedOpen} class="group/advanced flex flex-col gap-4">
        <Collapsible.Trigger
          class="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer items-center gap-1 text-sm transition-colors"
        >
          <ChevronRightIcon
            class="size-4 transition-transform group-data-[state=open]/advanced:rotate-90"
          />
          Advanced
        </Collapsible.Trigger>
        <Collapsible.Content class="flex flex-col gap-6">
          <Field.Field>
            <div class="flex items-center gap-3">
              <Switch
                id="memory-agent-only"
                bind:checked={memoryAgentOnly}
                aria-describedby="memory-agent-only-description"
              />
              <Label for="memory-agent-only">Scope memories to this agent only</Label>
            </div>
            <Field.FieldDescription id="memory-agent-only-description">
              Only read and propose memories private to this agent. Shared organisation and repository
              memories, other agents' memories, and shared source documents are not accessible.
              New memories are always private to this agent. This does not hide them from people
              with memory access or change memories from earlier runs.
            </Field.FieldDescription>
          </Field.Field>
          <Field.Field>
            <Field.FieldLabel for="memory-budget">Brief budget (tokens)</Field.FieldLabel>
            <Input
              id="memory-budget"
              type="number"
              min="0"
              max="100000"
              step="100"
              bind:value={memoryBudget}
              placeholder="2000"
            />
            <Field.FieldDescription>
              How much of the canon rides into each run's prompt. Pinned memories always fit; what
              does not fit is summarised as a topic index the agent can search. Zero keeps the tools
              and drops the brief.
            </Field.FieldDescription>
          </Field.Field>
        </Collapsible.Content>
      </Collapsible.Root>
    {/if}
  </Field.FieldGroup>
</Field.FieldSet>
