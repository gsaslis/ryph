<script lang="ts">
import * as Field from "$lib/components/ui/field";
import { Label } from "$lib/components/ui/label";
import { Switch } from "$lib/components/ui/switch";

let {
  canOpenPatches = $bindable(),
  locked = false,
}: {
  /** Whether the agent's runs may open patches. */
  canOpenPatches: boolean;
  /** True when the switch is off and only an administrator may turn it back on. */
  locked?: boolean;
} = $props();
</script>

<Field.FieldSet>
  <Field.FieldLegend>Patches</Field.FieldLegend>
  <Field.FieldDescription>
    When patches are off, the agent can't open patches, pull requests or merge requests, and any
    code it changes is discarded at the end of a run. It can still report what it found.
  </Field.FieldDescription>
  <Field.FieldGroup>
    <div class="flex items-center gap-3">
      <Switch id="can-open-patches" bind:checked={canOpenPatches} disabled={locked} />
      <Label for="can-open-patches">Let this agent open patches</Label>
    </div>
    {#if locked}
      <Field.FieldDescription>Only an administrator can turn patches back on.</Field.FieldDescription>
    {/if}
  </Field.FieldGroup>
</Field.FieldSet>
