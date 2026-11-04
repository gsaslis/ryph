<script lang="ts">
import { Button } from "$lib/components/ui/button";
import { Checkbox } from "$lib/components/ui/checkbox";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Label } from "$lib/components/ui/label";
import * as Select from "$lib/components/ui/select";
import * as ToggleGroup from "$lib/components/ui/toggle-group";
import { THINKING_LEVELS, type ThinkingLevel } from "$lib/api/types";
import { THINKING_LABELS } from "$lib/components/model-picker/thinking";
import PlusIcon from "@lucide/svelte/icons/plus";
import Trash2Icon from "@lucide/svelte/icons/trash-2";
import { emptyModelRow, type EndpointFormState, withReasoning } from "./custom-endpoint-form";

// A custom endpoint's fields, for the Model keys dialog that registers and edits one and for the
// welcome flow that registers one alongside its key.
let {
  form = $bindable(),
  editing = false,
  class: className,
}: {
  form: EndpointFormState;
  /** An existing endpoint: its slug is fixed once anything references it. */
  editing?: boolean;
  class?: string;
} = $props();
</script>

<Field.FieldGroup class={className}>
  <Field.Field>
    <Field.FieldLabel for="endpoint-label">Label</Field.FieldLabel>
    <Input
      id="endpoint-label"
      required
      bind:value={form.label}
      placeholder="Cloudflare Workers AI"
    />
    <Field.FieldDescription>Your name for it, shown around the app.</Field.FieldDescription>
  </Field.Field>
  <Field.Field>
    <Field.FieldLabel for="endpoint-slug">Slug</Field.FieldLabel>
    <Input
      id="endpoint-slug"
      required
      disabled={editing}
      bind:value={form.id}
      placeholder="workers-ai"
      pattern="[a-z0-9][a-z0-9-]*"
      maxlength={64}
    />
    <Field.FieldDescription>
      {editing
      ? "Keys and agents refer to it by this, so it can't change."
      : "How Ryph refers to this provider. Lowercase letters, digits and dashes. It can't be changed later."}
    </Field.FieldDescription>
  </Field.Field>
  <Field.Field>
    <Field.FieldLabel for="endpoint-base-url">Base URL</Field.FieldLabel>
    <Input
      id="endpoint-base-url"
      required
      bind:value={form.baseUrl}
      placeholder="https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1"
      autocomplete="off"
    />
    <Field.FieldDescription>
      Copy it exactly as your provider's docs give it for OpenAI clients, usually ending in
      <code>/v1</code>. A URL cut short fails every call. Must be HTTPS. For an endpoint on your
      own network, start Ryph with <code>RYPH_ALLOW_PRIVATE_MODEL_ENDPOINTS</code>.
    </Field.FieldDescription>
  </Field.Field>

  <Field.FieldSet>
    <Field.FieldLegend>Credential header</Field.FieldLegend>
    <Field.FieldDescription>
      How the key is sent. Most endpoints want <code>authorization: Bearer …</code>. Azure
      OpenAI wants the key alone in <code>api-key</code>.
    </Field.FieldDescription>
    <Field.FieldGroup>
      <div class="grid gap-3 sm:grid-cols-2">
        <Field.Field>
          <Field.FieldLabel for="endpoint-auth-header">Header</Field.FieldLabel>
          <Input
            id="endpoint-auth-header"
            bind:value={form.authHeader}
            placeholder="authorization"
            autocomplete="off"
          />
        </Field.Field>
        <Field.Field>
          <Field.FieldLabel for="endpoint-auth-scheme">Scheme</Field.FieldLabel>
          <Select.Root
            type="single"
            value={form.authScheme === "" ? "bare" : form.authScheme}
            onValueChange={(value) => {
              form.authScheme = value === "bare" ? "" : value;
            }}
          >
            <Select.Trigger id="endpoint-auth-scheme" class="w-full">
              {form.authScheme === ""
              ? "None (key only)"
              : form.authScheme}
            </Select.Trigger>
            <Select.Content>
              <Select.Group>
                <Select.Item value="Bearer" label="Bearer" />
                <Select.Item value="bare" label="None (key only)" />
              </Select.Group>
            </Select.Content>
          </Select.Root>
        </Field.Field>
      </div>

      <Field.Field>
        <Field.FieldLabel>Extra headers</Field.FieldLabel>
        <Field.FieldDescription>
          Sent with every request, like a tenant id or an API version. They aren't secret:
          anyone who can edit this endpoint can see them. The API key goes in the key field.
        </Field.FieldDescription>
        <div class="flex flex-col gap-2">
          {#each form.headers as _header, i (i)}
            <div class="flex items-center gap-2">
              <Input
                bind:value={form.headers[i].name}
                placeholder="x-tenant"
                aria-label="Header name"
                autocomplete="off"
              />
              <Input
                bind:value={form.headers[i].value}
                placeholder="acme"
                aria-label="Header value"
                autocomplete="off"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove header"
                onclick={() => {
                  form.headers.splice(i, 1);
                }}
              >
                <Trash2Icon />
              </Button>
            </div>
          {/each}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onclick={() => {
                form.headers.push({ name: "", value: "" });
              }}
            >
              <PlusIcon data-icon="inline-start" />
              Add header
            </Button>
          </div>
        </div>
      </Field.Field>
    </Field.FieldGroup>
  </Field.FieldSet>

  <Field.FieldSet>
    <Field.FieldLegend>Models</Field.FieldLegend>
    <Field.FieldDescription>
      The models this endpoint serves. Ryph can't look them up, so add each one agents
      should use.
    </Field.FieldDescription>
    <Field.FieldGroup>
      {#each form.models as _model, i (i)}
        <div class="flex flex-col gap-3 rounded-md border p-3">
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm font-medium">Model {i + 1}</span>
            {#if form.models.length > 1}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove model"
                onclick={() => {
                  form.models.splice(i, 1);
                }}
              >
                <Trash2Icon />
              </Button>
            {/if}
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <Field.Field>
              <Field.FieldLabel for="endpoint-model-{i}-id">Model id</Field.FieldLabel>
              <Input
                id="endpoint-model-{i}-id"
                bind:value={form.models[i].id}
                placeholder="@cf/meta/llama-3.1-8b-instruct"
                autocomplete="off"
              />
              <Field.FieldDescription>
                Exactly as the endpoint spells it.
              </Field.FieldDescription>
            </Field.Field>
            <Field.Field>
              <Field.FieldLabel for="endpoint-model-{i}-label">Display name</Field.FieldLabel>
              <Input
                id="endpoint-model-{i}-label"
                bind:value={form.models[i].label}
                placeholder="Llama 3.1 8B"
              />
              <Field.FieldDescription>Optional.</Field.FieldDescription>
            </Field.Field>
            <Field.Field>
              <Field.FieldLabel for="endpoint-model-{i}-context">
                Context window
              </Field.FieldLabel>
              <Input
                id="endpoint-model-{i}-context"
                inputmode="numeric"
                bind:value={form.models[i].contextWindow}
                placeholder="128000"
              />
            </Field.Field>
            <Field.Field>
              <Field.FieldLabel for="endpoint-model-{i}-max-output">
                Max output tokens
              </Field.FieldLabel>
              <Input
                id="endpoint-model-{i}-max-output"
                inputmode="numeric"
                bind:value={form.models[i].maxOutputTokens}
                placeholder="16384"
              />
            </Field.Field>
          </div>
          <Field.FieldDescription>
            Optional. Leave them empty to use the defaults.
          </Field.FieldDescription>
          <div class="flex flex-wrap items-center gap-6">
            <div class="flex items-center gap-2">
              <Checkbox
                id="endpoint-model-{i}-reasoning"
                bind:checked={
                  () => form.models[i].reasoning,
                  (next) => (form.models[i] = withReasoning(form.models[i], next))
                }
              />
              <Label for="endpoint-model-{i}-reasoning">Reasoning</Label>
            </div>
            <div class="flex items-center gap-2">
              <Checkbox
                id="endpoint-model-{i}-vision"
                bind:checked={form.models[i].vision}
              />
              <Label for="endpoint-model-{i}-vision">Can see images</Label>
            </div>
          </div>
          {#if form.models[i].reasoning}
            <Field.Field>
              <Field.FieldLabel id="endpoint-model-{i}-thinking">Thinking levels</Field.FieldLabel>
              <ToggleGroup.Root
                type="multiple"
                variant="outline"
                size="sm"
                spacing={1}
                class="flex-wrap"
                aria-labelledby="endpoint-model-{i}-thinking"
                value={form.models[i].thinkingLevels}
                onValueChange={(value: string[]) => {
                  form.models[i].thinkingLevels = value as ThinkingLevel[];
                }}
              >
                {#each THINKING_LEVELS as level (level)}
                  <ToggleGroup.Item value={level}>{THINKING_LABELS[level]}</ToggleGroup.Item>
                {/each}
              </ToggleGroup.Root>
              <Field.FieldDescription>Optional. None selected offers Off to High.</Field.FieldDescription>
            </Field.Field>
          {/if}
          <div class="grid gap-3 sm:grid-cols-4">
            <Field.Field>
              <Field.FieldLabel for="endpoint-model-{i}-price-in">Input</Field.FieldLabel>
              <Input
                id="endpoint-model-{i}-price-in"
                inputmode="decimal"
                bind:value={form.models[i].inputPrice}
                placeholder="0.30"
              />
            </Field.Field>
            <Field.Field>
              <Field.FieldLabel for="endpoint-model-{i}-price-out">Output</Field.FieldLabel>
              <Input
                id="endpoint-model-{i}-price-out"
                inputmode="decimal"
                bind:value={form.models[i].outputPrice}
                placeholder="0.60"
              />
            </Field.Field>
            <Field.Field>
              <Field.FieldLabel for="endpoint-model-{i}-price-cr">Cache read</Field.FieldLabel>
              <Input
                id="endpoint-model-{i}-price-cr"
                inputmode="decimal"
                bind:value={form.models[i].cacheReadPrice}
                placeholder="0"
              />
            </Field.Field>
            <Field.Field>
              <Field.FieldLabel for="endpoint-model-{i}-price-cw">
                Cache write
              </Field.FieldLabel>
              <Input
                id="endpoint-model-{i}-price-cw"
                inputmode="decimal"
                bind:value={form.models[i].cacheWritePrice}
                placeholder="0"
              />
            </Field.Field>
          </div>
          <Field.FieldDescription>
            USD per million tokens. Fill in all four or none. Without prices, the Usage page
            shows the model as <strong>unpriced</strong>, not free.
          </Field.FieldDescription>
        </div>
      {/each}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onclick={() => {
            form.models.push(emptyModelRow());
          }}
        >
          <PlusIcon data-icon="inline-start" />
          Add model
        </Button>
      </div>
    </Field.FieldGroup>
  </Field.FieldSet>
</Field.FieldGroup>
