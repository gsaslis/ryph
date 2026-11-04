<script lang="ts">
import * as Field from "$lib/components/ui/field";
import { Textarea } from "$lib/components/ui/textarea";

let { instructions = $bindable() }: { instructions: string } = $props();
</script>

<Field.FieldGroup>
  <Field.Field>
    <Field.FieldLabel for="instructions">Instructions</Field.FieldLabel>
    <Textarea
      id="instructions"
      bind:value={instructions}
      rows={14}
      placeholder="What should the agent do when this fires?"
    />
    <Field.FieldDescription>
      What the sender posted is attached for the agent to read, but it can't change these
      instructions.
    </Field.FieldDescription>
  </Field.Field>
</Field.FieldGroup>
