<script lang="ts">
import { rotateAutomationSecret } from "$lib/api/automations";
import { pastedSecretProblem, type PresetVerification } from "$lib/automations/presets";
import { Button } from "$lib/components/ui/button";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Spinner } from "$lib/components/ui/spinner";
import CircleCheckIcon from "@lucide/svelte/icons/circle-check";

// Where a sender's own signing secret is pasted. Saving replaces the secret at once: requests
// signed with the old one stop being accepted, and the pasted one is never shown back. Once a
// secret is saved the box folds away to a line saying so, with a way to replace it.
let {
  automationId,
  vendor,
  verification,
  saved = $bindable(false),
  replacing = false,
  onsaved,
}: {
  automationId: string;
  /** The sender's name, as the person knows it. */
  vendor: string;
  verification: { kind: PresetVerification["kind"] };
  /** Set once a secret has been saved here; starts true when one already was. */
  saved?: boolean;
  /** A secret already works, and this replaces it: it keeps working until the new one is saved. */
  replacing?: boolean;
  onsaved?: () => void;
} = $props();

let secret = $state("");
let touched = $state(false);
let saving = $state(false);
let failure = $state<string | null>(null);
/** Saved in this visit, as opposed to saved before it opened. */
let justSaved = $state(false);
/** The saved line was asked to open the box again. */
let reopened = $state(false);

const problem = $derived(pastedSecretProblem(secret, verification, vendor));
const shown = $derived(touched && secret !== "" ? problem : null);
const open = $derived(!saved || reopened);
const replacingNow = $derived(replacing || saved);

// Not a form of its own: it sits inside the create flow's form, and forms don't nest. Enter
// saves here instead of reaching the outer form.
async function save() {
  touched = true;
  if (problem !== null) return;
  saving = true;
  failure = null;
  try {
    await rotateAutomationSecret(fetch, automationId, secret.trim());
    saved = true;
    justSaved = true;
    reopened = false;
    secret = "";
    touched = false;
    onsaved?.();
  } catch (e) {
    failure = e instanceof Error ? e.message : "The secret wasn't saved. Try again.";
  } finally {
    saving = false;
  }
}
</script>

{#if open}
  <Field.Field data-invalid={shown !== null || failure !== null ? true : undefined}>
    <Field.FieldLabel for="pasted-secret">Paste the signing secret from {vendor}</Field.FieldLabel>
    <div class="flex flex-col gap-2 sm:flex-row">
      <Input
        id="pasted-secret"
        type="password"
        autocomplete="off"
        spellcheck={false}
        class="font-mono"
        placeholder={verification.kind === "standard-webhooks" ? "whsec_…" : "Signing secret"}
        aria-invalid={shown !== null || failure !== null ? true : undefined}
        bind:value={secret}
        onblur={() => (touched = true)}
        onkeydown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          }
        }}
      />
      <Button type="button" onclick={save} disabled={saving || secret.trim() === ""} class="shrink-0">
        {#if saving}<Spinner data-icon="inline-start" />{/if}
        Save secret
      </Button>
      {#if reopened}
        <Button type="button" variant="ghost" class="shrink-0" onclick={() => (reopened = false)}>
          Cancel
        </Button>
      {/if}
    </div>
    {#if shown !== null || failure !== null}
      <Field.FieldError>{shown ?? failure}</Field.FieldError>
    {:else if replacingNow}
      <Field.FieldDescription>The current secret keeps working until you save.</Field.FieldDescription>
    {:else}
      <Field.FieldDescription>
        Until it's saved, requests from {vendor} are turned away.
      </Field.FieldDescription>
    {/if}
  </Field.Field>
{:else}
  <div class="flex flex-wrap items-center justify-between gap-2">
  <p class="flex items-center gap-1.5 text-sm text-success" role="status">
      <CircleCheckIcon class="size-4 shrink-0" />
      {justSaved
        ? `Secret saved. Requests from ${vendor} are accepted now.`
        : `The signing secret from ${vendor} is saved.`}
    </p>
  <Button type="button" variant="outline" size="sm" onclick={() => (reopened = true)}>
      Replace
    </Button>
</div>
{/if}
