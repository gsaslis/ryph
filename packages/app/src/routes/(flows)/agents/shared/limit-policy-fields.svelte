<script lang="ts">
import type { DeploymentLimits } from "$lib/api/types";
import * as Alert from "$lib/components/ui/alert";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import InfoIcon from "@lucide/svelte/icons/info";
import ToggleRow from "$lib/components/toggle-row/toggle-row.svelte";
import { formatElapsed } from "$lib/utils/format";
import { ceilingHours, type LimitFields } from "./limit-policy";

let {
  fields = $bindable(),
  limits,
  canGrant,
}: {
  /** Each limit's tick and value; capping nothing saves as the ceiling's values. */
  fields: LimitFields;
  /** The operator's ceiling, or null when the control plane did not answer for it. */
  limits: DeploymentLimits | null;
  /** Whether this user may change limits: an admin's call in both directions, because removing
   * them hands the agent the deployment's ceiling back. */
  canGrant: boolean;
} = $props();

const editable = $derived(limits !== null && canGrant);
const hours = $derived(ceilingHours(limits));
const wallClockCap = $derived(limits?.ceiling.wallClockMs ?? null);
const spendCap = $derived(limits?.ceiling.spendUsd ?? null);
const callsCap = $derived(limits?.ceiling.callsInFlight ?? null);
</script>

<Field.FieldSet>
  <Field.FieldLegend>Limits</Field.FieldLegend>
  <Field.FieldDescription>
    How long a run of this agent may run, how much it may spend, and how many model calls it
    may hold open. Each caps the deployment's ceiling for this agent alone; a task may lower them
    further when it starts.
  </Field.FieldDescription>
  {#if limits === null}
    <Alert.Root>
      <InfoIcon />
      <Alert.Title>Cannot be shown right now</Alert.Title>
      <Alert.Description>
        The control plane did not answer with its ceiling, so these cannot be read or changed.
        Everything else saves as usual, and they are left as they stand.
      </Alert.Description>
    </Alert.Root>
  {:else}
    {#if !canGrant}
      <Alert.Root>
        <InfoIcon />
        <Alert.Title>An administrator's call</Alert.Title>
        <Alert.Description>
          Changing these needs an administrator, in both directions: removing them hands the
          agent the deployment's ceiling back.
        </Alert.Description>
      </Alert.Root>
    {/if}
    <div class="divide-y rounded-lg border">
      <ToggleRow
        id="limit-wall-clock"
        label="Wall clock"
        description={wallClockCap === null
          ? "How long a run may run from launch. The deployment sets no cap."
          : `How long a run may run from launch. The deployment caps it at ${
            formatElapsed(wallClockCap)
          }.`}
        disabled={!editable}
        bind:checked={fields.wallClock}
      >
        <Field.Field class="sm:w-40">
          <Field.FieldLabel for="limit-wall-clock-hours" class="text-xs">Hours</Field.FieldLabel>
          <Input
            id="limit-wall-clock-hours"
            type="number"
            min="0.02"
            max={hours ?? undefined}
            step="0.25"
            class="h-8"
            disabled={!editable}
            placeholder={hours === null ? "No cap" : String(hours)}
            bind:value={fields.wallClockHours}
          />
        </Field.Field>
      </ToggleRow>
      <ToggleRow
        id="limit-spend"
        label="Spend"
        description={spendCap === null
          ? "What a run may spend on model calls, at list price. The deployment sets no cap."
          : `What a run may spend on model calls, at list price. The deployment caps it at $${spendCap}.`}
        disabled={!editable}
        bind:checked={fields.spend}
      >
        <Field.Field class="sm:w-40">
          <Field.FieldLabel for="limit-spend-usd" class="text-xs">US dollars</Field.FieldLabel>
          <Input
            id="limit-spend-usd"
            type="number"
            min="0.01"
            max={spendCap ?? undefined}
            step="0.01"
            class="h-8"
            disabled={!editable}
            placeholder={spendCap === null ? "No cap" : String(spendCap)}
            bind:value={fields.spendUsd}
          />
        </Field.Field>
      </ToggleRow>
      <ToggleRow
        id="limit-calls"
        label="Model calls in flight"
        description={callsCap === null
          ? "How many model calls a run may hold open at once. The deployment sets no cap."
          : `How many model calls a run may hold open at once. The deployment caps it at ${callsCap}.`}
        disabled={!editable}
        bind:checked={fields.calls}
      >
        <Field.Field class="sm:w-40">
          <Field.FieldLabel for="limit-calls-in-flight" class="text-xs">At once</Field.FieldLabel>
          <Input
            id="limit-calls-in-flight"
            type="number"
            min="1"
            max={callsCap ?? 64}
            step="1"
            class="h-8"
            disabled={!editable}
            placeholder={callsCap === null ? "No cap" : String(callsCap)}
            bind:value={fields.callsInFlight}
          />
        </Field.Field>
      </ToggleRow>
    </div>
    <Field.FieldDescription>
      A run past its wall clock or its spend cap is asked to stop and says which limit ended it.
      A blank value under a ticked row is the deployment's own.
    </Field.FieldDescription>
  {/if}
</Field.FieldSet>
