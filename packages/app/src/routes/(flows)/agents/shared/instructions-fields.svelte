<script lang="ts">
import * as Field from "$lib/components/ui/field";
import { Textarea } from "$lib/components/ui/textarea";

let { systemPrompt = $bindable() }: { systemPrompt: string } = $props();
</script>

<Field.FieldGroup>
  <Field.Field>
    <Field.FieldLabel for="system-prompt">System prompt</Field.FieldLabel>
    <Textarea
      id="system-prompt"
      bind:value={systemPrompt}
      rows={16}
      placeholder="Optional instructions injected into every run."
    />
  </Field.Field>
</Field.FieldGroup>
