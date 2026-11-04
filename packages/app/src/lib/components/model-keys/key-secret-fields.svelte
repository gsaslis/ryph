<script lang="ts">
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";

// A provider key's own two fields, its name and its secret, for the Model keys dialog and the
// welcome flow. The provider it is registered against is picked by whoever holds these.
let {
  label = $bindable(),
  secret = $bindable(),
  secretPlaceholder = "sk-ant-…",
  idPrefix = "add",
}: {
  label: string;
  secret: string;
  secretPlaceholder?: string;
  /** Keeps the fields' ids apart where two sets could be on one page. */
  idPrefix?: string;
} = $props();
</script>

<Field.Field>
  <Field.FieldLabel for="{idPrefix}-label">Label</Field.FieldLabel>
  <Input id="{idPrefix}-label" required bind:value={label} placeholder="Team key" />
  <Field.FieldDescription>
    Your name for it, like "Team key" or "CI key".
  </Field.FieldDescription>
</Field.Field>
<Field.Field>
  <Field.FieldLabel for="{idPrefix}-secret">API key</Field.FieldLabel>
  <Input
    id="{idPrefix}-secret"
    type="password"
    required
    bind:value={secret}
    placeholder={secretPlaceholder}
    autocomplete="off"
  />
  <Field.FieldDescription>
    Prefer a scoped, spend-capped key from your provider's console.
  </Field.FieldDescription>
</Field.Field>
