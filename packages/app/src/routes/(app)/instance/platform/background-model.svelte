<script lang="ts">
import { invalidate } from "$app/navigation";
import { clearPlatformModelPolicy, setPlatformModelPolicy } from "$lib/api/provider-keys";
import { Button } from "$lib/components/ui/button";
import * as Field from "$lib/components/ui/field";
import ModelSelect from "$lib/components/model-picker/model-select.svelte";
import { modelsForKey } from "$lib/components/model-picker/models";
import * as Select from "$lib/components/ui/select";
import { Spinner } from "$lib/components/ui/spinner";
import { toast } from "svelte-sonner";
import type { PlatformModelPolicy, Provider, ProviderKey } from "$lib/api/types";

let { providerKeys, providers, platformPolicy }: {
  providerKeys: ProviderKey[];
  providers: Provider[];
  platformPolicy: PlatformModelPolicy | null;
} = $props();
// The script below was written against the page's `data`; these keep its reads unchanged.
const data = $derived({ providerKeys, platformPolicy });

// ── the platform's own policy ───────────────────────────────────────────────────────────────
//
// Which key the platform's background model calls spend — the memory consolidator's judgement
// and the ingest extractor. Seeded from the stored policy on every load; saved as a whole.
const liveKeys = $derived(data.providerKeys.filter((key) => key.archivedAt === null));
// svelte-ignore state_referenced_locally
let platformKeyId = $state(data.platformPolicy?.providerKeyId ?? "");
// svelte-ignore state_referenced_locally
let platformModel = $state(data.platformPolicy?.model ?? "");
$effect(() => {
  platformKeyId = data.platformPolicy?.providerKeyId ?? "";
  platformModel = data.platformPolicy?.model ?? "";
});
let savingPlatform = $state(false);
const platformKey = $derived(data.providerKeys.find((key) => key.id === platformKeyId));
// The key's own list: a ChatGPT plan's provider entry is every plan key's models at once.
const keyModels = $derived(modelsForKey(providers, platformKey));

// Model ids belong to one provider, so moving to a key on another one starts the model fields
// over rather than carrying Claude ids onto an OpenAI key.
function chooseKey(value: string) {
  // The stored policy names its provider, for a stored key that no list can resolve any more.
  const from = platformKey?.provider ?? data.platformPolicy?.provider;
  platformKeyId = value;
  const to = data.providerKeys.find((key) => key.id === value)?.provider;
  if (from !== undefined && to !== undefined && from !== to) {
    platformModel = "";
  }
}

async function submitPlatform(event: SubmitEvent) {
  event.preventDefault();
  if (!platformKeyId) {
    toast.error("Pick a key");
    return;
  }
  if (!platformModel.trim()) {
    toast.error("Pick a model");
    return;
  }
  savingPlatform = true;
  try {
    await setPlatformModelPolicy(fetch, {
      providerKeyId: platformKeyId,
      model: platformModel.trim(),
      // Background jobs use the explicit model, not a separately configured allowlist.
      allowedModels: "*",
    });
    toast.success("Background model saved");
    await invalidate("app:platform");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to save the platform policy");
  } finally {
    savingPlatform = false;
  }
}

async function clearPlatform() {
  savingPlatform = true;
  try {
    await clearPlatformModelPolicy(fetch);
    toast.success("Background model cleared. Background work now runs without a model.");
    await invalidate("app:platform");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to clear the platform policy");
  } finally {
    savingPlatform = false;
  }
}
</script>

<form class="flex flex-col gap-4" onsubmit={submitPlatform}>
<Field.FieldGroup>
  <Field.Field>
    <Field.FieldLabel for="platform-key">Provider key</Field.FieldLabel>
    <Select.Root type="single" value={platformKeyId} onValueChange={chooseKey}>
      <Select.Trigger id="platform-key" class="w-full max-w-md">
        {#if platformKey}
          {`${platformKey.label} (${platformKey.provider} ····${platformKey.last4})`}
        {:else if platformKeyId}
          {platformKeyId} — archived or unknown
        {:else}
          No platform model access
        {/if}
      </Select.Trigger>
      <Select.Content>
        <Select.Group>
          {#each liveKeys as key (key.id)}
            <Select.Item
              value={key.id}
              label={`${key.label} (${key.provider} ····${key.last4})`}
            />
          {/each}
        </Select.Group>
      </Select.Content>
    </Select.Root>
  </Field.Field>
  <Field.Field>
    <Field.FieldLabel for="platform-model">Model</Field.FieldLabel>
    <ModelSelect
      id="platform-model"
      class="max-w-md"
      bind:value={platformModel}
      models={keyModels}
      allowCustom
      required
    />
    <Field.FieldDescription>
      What the background jobs call. A fast, cheap model does this job well.
    </Field.FieldDescription>
  </Field.Field>
</Field.FieldGroup>
<div class="flex gap-2">
  <Button type="submit" disabled={savingPlatform || liveKeys.length === 0}>
    {#if savingPlatform}
      <Spinner data-icon="inline-start" />
    {/if}
    Save
  </Button>
  {#if data.platformPolicy !== null}
    <Button type="button" variant="outline" disabled={savingPlatform} onclick={clearPlatform}>
      Turn off
    </Button>
  {/if}
</div>
{#if liveKeys.length === 0}
  <p class="text-muted-foreground text-sm">Register a provider key first.</p>
{/if}
</form>
