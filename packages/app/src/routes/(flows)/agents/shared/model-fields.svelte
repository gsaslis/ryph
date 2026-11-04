<script lang="ts">
import type { Harness, ModelPolicy, Provider, ProviderKey } from "$lib/api/types";
import * as Alert from "$lib/components/ui/alert";
import InfoIcon from "@lucide/svelte/icons/info";
import { Button } from "$lib/components/ui/button";
import * as Field from "$lib/components/ui/field";
import * as Select from "$lib/components/ui/select";
import ModelAllowlist from "$lib/components/model-picker/model-allowlist.svelte";
import ModelSelect from "$lib/components/model-picker/model-select.svelte";
import { choicesFor, modelsForKey } from "$lib/components/model-picker/models";
import ThinkingSelect from "$lib/components/model-picker/thinking-select.svelte";
import { offersThinking, thinkingInvalid } from "$lib/components/model-picker/thinking";
import { CHATGPT_MANAGE_USAGE_URL } from "$lib/api/chatgpt-plan";
import { defaultModelThinkingLevels, storedProvider, usableProviderKeys } from "./model-policy";

let {
  providerKeyId = $bindable(),
  allowedModels = $bindable(),
  defaultModel = $bindable(),
  defaultThinking = $bindable(),
  harness,
  providerKeys,
  providers,
  modelAccessEnabled,
  storedPolicy,
}: {
  /** "" means no model access. */
  providerKeyId: string;
  allowedModels: ModelPolicy["allowedModels"];
  defaultModel: string;
  /** null is the harness's own default. */
  defaultThinking: ModelPolicy["defaultThinking"];
  /** The agent's harness, for which keys it can drive; undefined offers every key. */
  harness: Harness | undefined;
  providerKeys: ProviderKey[];
  /** The upstreams keys are registered against — the two built-ins and every custom endpoint.
   * A key is joined to one of these on `key.provider`, which is how the form learns the dialect
   * the key speaks and the models the endpoint offers. */
  providers: Provider[];
  /** false when the deployment runs without model access: no key can be registered or used. */
  modelAccessEnabled: boolean;
  /** The policy already on the agent, so an editor can name a key the key list cannot resolve. */
  storedPolicy: ModelPolicy | null;
} = $props();

const providerById = $derived(new Map(providers.map((p) => [p.id, p])));
const liveKeys = $derived(providerKeys.filter((key) => key.archivedAt === null));
// Keys the agent's harness can actually drive (see `usableProviderKeys` for which drop out).
const usableKeys = $derived(usableProviderKeys(providerKeys, providers, harness));
// True when the keys are all there is and every one of them hangs off an archived endpoint —
// the one case where blaming the harness would be a lie, since it can drive them all.
const onlyArchivedEndpoints = $derived(
  liveKeys.length > 0 && usableKeys.length === 0 &&
    liveKeys.every((key) => providerById.get(key.provider)?.archivedAt != null),
);
const selectedKey = $derived(providerKeys.find((key) => key.id === providerKeyId));
// The models the selected key's endpoint offers — a custom endpoint's declared list, or the price
// list's for a built-in. Both pickers still take a typed id, because an endpoint may serve more.
// A key the list cannot resolve reads the stored policy's provider entry instead.
const keyModels = $derived(
  modelsForKey(providers, selectedKey, storedProvider(storedPolicy, providerKeyId)),
);
// With an allowlist, the default is picked from it and from nothing else.
const defaultChoices = $derived(choicesFor(keyModels, allowedModels));
// The levels the default model takes, as pi will run it (see `thinkingLevelsFor`).
const thinkingLevels = $derived(
  defaultModelThinkingLevels(providers, providerKeys, providerKeyId, defaultModel, storedPolicy),
);
// A key the list cannot account for: with model access off there are no rows to match, so a
// standing policy would otherwise read as no policy at all. The stored one names it instead.
const unresolvedPolicy = $derived(
  selectedKey === undefined && providerKeyId !== "" && storedPolicy?.providerKeyId === providerKeyId
    ? storedPolicy
    : null,
);

// The provider the model fields were picked for. Model ids belong to one provider, so moving to
// a key on another one starts them over rather than carrying Claude ids onto an OpenAI key.
// A plain variable: only `chooseKey` reads it, and nothing renders from it.
// svelte-ignore state_referenced_locally
let modelsProvider = selectedKey?.provider ?? storedPolicy?.provider;

/** "Team key (anthropic ····abcd)", or the signed-in account for a ChatGPT plan key. */
function keyOptionLabel(key: ProviderKey): string {
  if (key.plan !== undefined) {
    return `${key.label} (ChatGPT plan${key.plan.email ? `, ${key.plan.email}` : ""})`;
  }
  return `${key.label} (${key.provider} ····${key.last4})`;
}

function chooseKey(value: string) {
  providerKeyId = value === "none" ? "" : value;
  const provider = providerKeys.find((key) => key.id === providerKeyId)?.provider;
  if (provider === undefined) return;
  if (modelsProvider !== undefined && provider !== modelsProvider) {
    allowedModels = "*";
    defaultModel = "";
  }
  modelsProvider = provider;
}

// A key that fell out of reach (archived since the page loaded) must not linger selected. With
// model access off there are no keys to reach, so every selection would look out of reach —
// clearing then would misread "cannot be shown" as "was deselected".
$effect(() => {
  if (modelAccessEnabled && providerKeyId && !usableKeys.some((key) => key.id === providerKeyId)) {
    providerKeyId = "";
  }
});
</script>

<Field.FieldGroup>
  <Alert.Root>
    <InfoIcon />
    <Alert.Title>Agents never receive raw model keys</Alert.Title>
    <Alert.Description>
      Ryph automatically issues short-lived model credentials for each run, which are revoked as
      soon as the run completes.
    </Alert.Description>
  </Alert.Root>
  <Field.Field>
    <Field.FieldLabel for="provider-key">Provider key</Field.FieldLabel>
    <Select.Root
      type="single"
      disabled={!modelAccessEnabled}
      value={providerKeyId || "none"}
      onValueChange={chooseKey}
    >
      <Select.Trigger id="provider-key" class="w-full">
        {#if selectedKey}
          {`${selectedKey.label} (${selectedKey.provider})`}
        {:else if unresolvedPolicy}
          {`${unresolvedPolicy.providerKeyId} (${unresolvedPolicy.provider}) — cannot be shown`}
        {:else}
          No model access
        {/if}
      </Select.Trigger>
      <Select.Content>
        <Select.Group>
          <Select.Item value="none" label="No model access" />
          {#each usableKeys as key (key.id)}
            <Select.Item
              value={key.id}
              label={keyOptionLabel(key)}
            />
          {/each}
        </Select.Group>
      </Select.Content>
    </Select.Root>
    {#if selectedKey?.plan}
      <!-- OpenAI asks for this line near the model choice whenever the plan pays for calls. -->
      <Field.FieldDescription>
        Using ChatGPT plan.
        {#if selectedKey.plan.status === "needs_reauth"}
          The account needs to sign in again on
          <a href="/model-keys" class="underline underline-offset-4">Model keys</a>.
        {:else if selectedKey.plan.status === "limited"}
          The plan's usage limit is reached.
          <a
            href={CHATGPT_MANAGE_USAGE_URL}
            target="_blank"
            rel="noreferrer"
            class="underline underline-offset-4"
          >
            Manage usage
          </a>
        {/if}
      </Field.FieldDescription>
    {/if}
    {#if unresolvedPolicy}
      <Field.FieldDescription>
        This deployment runs without model access, so this key cannot be shown or changed. Runs
        still carry the policy and fail at boot, with no credential to mint. Set
        <code>RYPH_SECRETS_KEY</code> on the host to restore it, or remove model access from this
        agent to let its runs proceed without a model.
      </Field.FieldDescription>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onclick={() => {
            providerKeyId = "";
          }}
        >
          Remove model access
        </Button>
      </div>
    {:else if !modelAccessEnabled}
      <Field.FieldDescription>
        This deployment runs without model access — no provider keys can be registered, and
        agents run without one. Set <code>RYPH_SECRETS_KEY</code> on the host to enable it.
      </Field.FieldDescription>
    {:else if liveKeys.length === 0}
      <Field.FieldDescription>
        No provider keys registered yet — add one under
        <a href="/model-keys" class="underline underline-offset-4">Model keys</a>.
      </Field.FieldDescription>
    {:else if onlyArchivedEndpoints}
      <Field.FieldDescription>
        Every registered key belongs to a custom endpoint that has been archived — an archived
        endpoint mints no credentials, so a run on one would fail at boot. Register a key against
        a live endpoint under
        <a href="/model-keys" class="underline underline-offset-4">Model keys</a>.
      </Field.FieldDescription>
    {:else if harness !== undefined && usableKeys.length === 0}
      <Field.FieldDescription>
        No registered key belongs to a provider the "{harness.kind}" harness can drive — it
        speaks {harness.dialects.join(", ") || "no model dialect at all"}.
      </Field.FieldDescription>
    {/if}
  </Field.Field>
  <!-- Only offered where a save can carry them: with model access off the policy is left
       untouched, so an editable allowlist would drop every edit without a word. -->
  {#if modelAccessEnabled && providerKeyId}
    <Field.Field>
      <Field.FieldLabel for="allowed-models">Allowed models</Field.FieldLabel>
      <ModelAllowlist id="allowed-models" bind:allowed={allowedModels} models={keyModels} />
      <Field.FieldDescription>The models the agent may call.</Field.FieldDescription>
    </Field.Field>
    <Field.Field>
      <Field.FieldLabel for="default-model">Default model</Field.FieldLabel>
      <ModelSelect
        id="default-model"
        bind:value={defaultModel}
        models={defaultChoices}
        emptyLabel="Harness default"
        allowCustom={allowedModels === "*"}
      />
      <Field.FieldDescription>Used when a task doesn't pick one.</Field.FieldDescription>
    </Field.Field>
    {#if offersThinking(thinkingLevels)}
      <Field.Field data-invalid={thinkingInvalid(defaultThinking, thinkingLevels) || undefined}>
        <Field.FieldLabel for="default-thinking">Thinking level</Field.FieldLabel>
        <ThinkingSelect
          id="default-thinking"
          bind:value={defaultThinking}
          levels={thinkingLevels}
          emptyLabel="Harness default"
        />
        <Field.FieldDescription>Used when a task doesn't pick one.</Field.FieldDescription>
      </Field.Field>
    {/if}
  {/if}
</Field.FieldGroup>
