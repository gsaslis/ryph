<script lang="ts">
import * as Field from "$lib/components/ui/field";
import { Label } from "$lib/components/ui/label";
import { Switch } from "$lib/components/ui/switch";

let {
  browserEnabled = $bindable(),
  unavailable,
  savedOn = false,
  locked = false,
}: {
  /** Whether the agent's runs get a browser of their own. */
  browserEnabled: boolean;
  /** Why this deployment can't give the agent's harness a browser (browserUnavailableNote), or
   * null when it can. The switch is then held off and the reason said under it. */
  unavailable: string | null;
  /** Whether the saved agent has the switch on. Keeps it movable where the deployment can't give
   * a browser, so it can be turned off and back again before saving. */
  savedOn?: boolean;
  /** True when the switch is off and only an administrator may turn it on. */
  locked?: boolean;
} = $props();

// Held off, and shown off, where the deployment can't give one: a switch left on after picking a
// harness without a browser is not what a new agent is sent (createBrowserEnabled).
const unreachable = $derived(unavailable !== null && !savedOn);
const held = $derived(locked || unreachable);
const note = $derived(
  unavailable !== null && browserEnabled && !unreachable
    ? `${unavailable} Its runs start without one.`
    : unavailable,
);
</script>

<Field.FieldSet>
  <Field.FieldLegend>Browser</Field.FieldLegend>
  <Field.FieldDescription>
    The agent can open pages, click and type in a browser of its own, including a dev server it
    starts. You can watch it live from the run.
  </Field.FieldDescription>
  <Field.FieldGroup>
    <div class="flex items-center gap-3">
      <Switch
        id="browser-enabled"
        bind:checked={() => browserEnabled && !unreachable, (next) => (browserEnabled = next)}
        disabled={held}
      />
      <Label for="browser-enabled">Give this agent a browser</Label>
    </div>
    {#if note !== null}
      <Field.FieldDescription>{note}</Field.FieldDescription>
    {:else if locked}
      <Field.FieldDescription>Only an administrator can give an agent a browser.</Field.FieldDescription>
    {/if}
  </Field.FieldGroup>
</Field.FieldSet>
