<script lang="ts">
import { PRESET_ICONS } from "$lib/automations/preset-icons";
import { presetById, type PresetId, PRESETS } from "$lib/automations/presets";
import CopyButton from "$lib/components/copy-button/copy-button.svelte";
import PickCard from "$lib/components/pick-card/pick-card.svelte";
import { Badge } from "$lib/components/ui/badge";
import * as Collapsible from "$lib/components/ui/collapsible";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select";
import * as ToggleGroup from "$lib/components/ui/toggle-group";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import ClockIcon from "@lucide/svelte/icons/clock";
import WebhookIcon from "@lucide/svelte/icons/webhook";
import { RadioGroup } from "bits-ui";
import {
  applyPreset,
  CRON_PRESETS,
  DEFAULT_HEADER,
  knownTimezones,
  presetOf,
  secretHint,
  type TriggerFields,
  type TriggerKind,
} from "./automation-steps";

// The trigger step: what starts the automation and what to call it. A new webhook first picks
// what sends it; a known sender fills in how requests are checked and read, and keeps that behind
// Advanced. A saved one keeps its kind and verification for good, since the sender was set up
// against them, so the edit shows those as facts and offers the sender's format, the rate limit,
// or the schedule itself.
let {
  name = $bindable(),
  fields = $bindable(),
  fixed = false,
  url = null,
}: {
  name: string;
  fields: TriggerFields;
  /** Set on an edit: the kind and the verification are shown, not offered. */
  fixed?: boolean;
  /** A saved webhook's address, for the sending service to be pointed at. */
  url?: string | null;
} = $props();

const timezones = knownTimezones();
const cronPreset = $derived(presetOf(fields.cron));
const headerPlaceholder = $derived(DEFAULT_HEADER[fields.verification]);
const preset = $derived(fields.preset === null ? null : presetById(fields.preset));
const other = $derived(fields.preset === "other");
// When the secret comes: it never exists before the automation does, so say so by the picker.
const hint = $derived(secretHint(fields));

function pickKind(kind: TriggerKind) {
  fields.kind = kind;
}

function pickPreset(id: PresetId) {
  // An empty name, or one a preset filled in, follows the pick; a name typed by hand stays.
  const filled = PRESETS.some((p) => p.defaultName !== "" && p.defaultName === name.trim());
  fields = applyPreset(fields, id);
  if (name.trim() === "" || filled) name = presetById(id).defaultName;
}

// On an edit, only the format follows the sender: the verification was fixed at creation.
function pickFormat(id: string) {
  const picked = PRESETS.find((p) => p.id === id);
  if (picked === undefined) return;
  fields.preset = picked.id;
}
</script>

<Field.FieldGroup>
  <Field.Field>
    <Field.FieldLabel for="trigger-kind">Starts when</Field.FieldLabel>
    {#if fixed}
      <div class="flex items-center gap-2 text-sm">
        {#if fields.kind === "webhook"}
          <WebhookIcon class="text-muted-foreground size-4" />
          Another service sends a request
        {:else}
          <ClockIcon class="text-muted-foreground size-4" />
          A schedule comes due
        {/if}
      </div>
      <Field.FieldDescription>
        Fixed once created. Delete and recreate the automation to change how it starts.
      </Field.FieldDescription>
    {:else}
      <ToggleGroup.Root
        type="single"
        variant="outline"
        value={fields.kind}
        onValueChange={(value) => {
          // The group lets its one item be unpicked; the kind cannot be.
          if (value === "webhook" || value === "schedule") pickKind(value);
        }}
        class="w-fit"
      >
        <ToggleGroup.Item value="webhook" id="trigger-kind">
          <WebhookIcon />
          Another service sends a request
        </ToggleGroup.Item>
        <ToggleGroup.Item value="schedule">
          <ClockIcon />
          A schedule comes due
        </ToggleGroup.Item>
      </ToggleGroup.Root>
    {/if}
  </Field.Field>

  {#if fields.kind === "webhook"}
    {#if fixed}
      {#if url !== null}
        <Field.Field>
          <Field.FieldLabel for="webhook-url">URL</Field.FieldLabel>
          <div class="bg-muted/50 flex items-center gap-2 rounded-md border p-2">
            <code id="webhook-url" class="min-w-0 flex-1 truncate font-mono text-xs" title={url}>
              {url}
            </code>
            <CopyButton value={url} label="Copy the URL" what="URL copied" />
          </div>
        </Field.Field>
      {/if}
      <Field.Field>
        <Field.FieldLabel for="sender">Sends from</Field.FieldLabel>
        <Select.Root type="single" value={fields.preset ?? "other"} onValueChange={pickFormat}>
          <Select.Trigger id="sender" class="w-full sm:max-w-xs">
            {preset?.name ?? "Something else"}
          </Select.Trigger>
          <Select.Content>
            <Select.Group>
              {#each PRESETS as p (p.id)}
                <Select.Item value={p.id} label={p.name} />
              {/each}
            </Select.Group>
          </Select.Content>
        </Select.Root>
        <Field.FieldDescription>
          Sets how each request is read. How requests are checked doesn't change.
        </Field.FieldDescription>
      </Field.Field>
    {:else}
      <Field.Field>
        <Field.FieldLabel id="sender-label">What sends it?</Field.FieldLabel>
        <div class="@container">
          <RadioGroup.Root
            value={fields.preset ?? ""}
            onValueChange={(value) => pickPreset(value as PresetId)}
            aria-labelledby="sender-label"
            class="grid grid-cols-1 gap-2 @sm:grid-cols-2 @xl:grid-cols-3"
          >
            {#each PRESETS as p (p.id)}
              {@const Icon = PRESET_ICONS[p.id]}
              <PickCard value={p.id}>
                {#snippet media()}
                  <span class="bg-background ring-border flex size-8 items-center justify-center rounded-md ring-1">
                    <Icon class="size-4" />
                  </span>
                {/snippet}
                {#snippet title()}
                  {p.name}
                {/snippet}
                {#snippet meta()}
                  {p.blurb}
                {/snippet}
              </PickCard>
            {/each}
          </RadioGroup.Root>
        </div>
        {#if hint !== null}
          <Field.FieldDescription>
            {hint}
            {#if !other}{preset?.note ?? ""}{/if}
          </Field.FieldDescription>
        {/if}
      </Field.Field>
    {/if}

    {#if fields.preset !== null}
      <Field.Field>
        <Field.FieldLabel for="name">Name</Field.FieldLabel>
        <Input id="name" bind:value={name} placeholder="Checkout errors" />
      </Field.Field>
    {/if}

    {#if other}
      <Field.Field>
        <Field.FieldLabel for="format">The body is</Field.FieldLabel>
        <ToggleGroup.Root
          type="single"
          variant="outline"
          value={fields.formatKind}
          onValueChange={(value) => {
            if (value === "raw" || value === "custom") {
              fields.formatKind = value;
            }
          }}
          class="w-fit"
        >
          <ToggleGroup.Item value="raw" id="format">Passed on as is</ToggleGroup.Item>
          <ToggleGroup.Item value="custom">Read with your own fields</ToggleGroup.Item>
        </ToggleGroup.Root>
        <Field.FieldDescription>
          {fields.formatKind === "raw"
            ? "The agent gets the body. Nothing is read from it, so every request counts as new."
            : "Say where to find the status, an ID and a title, so resolves and updates find their conversation."}
        </Field.FieldDescription>
      </Field.Field>
      {#if fields.formatKind === "custom"}
        {@render mappingFields()}
      {/if}
    {/if}

    {#if !fixed && other}
      {@render verificationFields()}
    {:else if !fixed && preset !== null}
      <Collapsible.Root class="group/advanced flex flex-col gap-4">
        <Collapsible.Trigger
          class="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm transition-colors"
        >
          <ChevronRightIcon
            class="size-4 transition-transform group-data-[state=open]/advanced:rotate-90"
          />
          Advanced
        </Collapsible.Trigger>
        <Collapsible.Content class="flex flex-col gap-6">
          {@render verificationFields()}
        </Collapsible.Content>
      </Collapsible.Root>
    {:else if fixed}
      <Field.Field>
        <Field.FieldLabel>Requests are trusted when</Field.FieldLabel>
        <div class="flex flex-wrap items-center gap-2 text-sm">
          {#if fields.verification === "hmac-sha256"}
            Signed with the secret, in the header
          {:else if fields.verification === "standard-webhooks"}
            Signed the Standard Webhooks way
          {:else}
            The secret is sent in the header
          {/if}
          {#if fields.verification !== "standard-webhooks"}
            <Badge variant="secondary" class="font-mono">
              {fields.header.trim() || headerPlaceholder}
            </Badge>
            {#if fields.prefix !== ""}
              <Badge variant="outline" class="font-mono">{fields.prefix}…</Badge>
            {/if}
          {/if}
        </div>
        <Field.FieldDescription>Fixed once created.</Field.FieldDescription>
      </Field.Field>
    {/if}

    {#if fields.preset !== null}
      <Field.Field class="sm:max-w-xs">
        <Field.FieldLabel for="fires-per-minute">Fires a minute, at most</Field.FieldLabel>
        <Input
          id="fires-per-minute"
          type="number"
          min="1"
          max="600"
          step="1"
          bind:value={fields.firesPerMinute}
        />
        <Field.FieldDescription>
          Requests over the limit are dropped.
        </Field.FieldDescription>
      </Field.Field>
    {/if}
  {:else}
    <Field.Field>
      <Field.FieldLabel for="name">Name</Field.FieldLabel>
      <Input id="name" bind:value={name} placeholder="Nightly dependency check" />
    </Field.Field>
    <Field.Field>
      <Field.FieldLabel for="cron-preset">Schedule</Field.FieldLabel>
      <Select.Root
        type="single"
        value={cronPreset ?? "custom"}
        onValueChange={(value) => {
          const picked = CRON_PRESETS.find((p) => p.label === value);
          if (picked) fields.cron = picked.cron;
        }}
      >
        <Select.Trigger id="cron-preset" class="w-full sm:max-w-xs">
          {cronPreset ?? "Custom"}
        </Select.Trigger>
        <Select.Content>
          <Select.Group>
            {#each CRON_PRESETS as p (p.cron)}
              <Select.Item value={p.label} label={p.label} />
            {/each}
            <Select.Item value="custom" label="Custom" disabled={cronPreset === null} />
          </Select.Group>
        </Select.Content>
      </Select.Root>
    </Field.Field>
    <div class="grid gap-6 sm:grid-cols-2">
      <Field.Field>
        <Field.FieldLabel for="cron">Cron expression</Field.FieldLabel>
        <Input id="cron" bind:value={fields.cron} placeholder="*/5 * * * *" class="font-mono" />
        <Field.FieldDescription>
          Minute, hour, day, month, weekday. Never more often than every five minutes.
        </Field.FieldDescription>
      </Field.Field>
      <Field.Field>
        <Field.FieldLabel for="timezone">Timezone</Field.FieldLabel>
        <Input id="timezone" bind:value={fields.timezone} placeholder="UTC" list="timezones" />
        <datalist id="timezones">
          {#each timezones as zone (zone)}
            <option value={zone}></option>
          {/each}
        </datalist>
        <Field.FieldDescription>
          An IANA name like <code class="font-mono">Europe/Athens</code>, so 09:00 stays 09:00
          across daylight saving.
        </Field.FieldDescription>
      </Field.Field>
    </div>
  {/if}
</Field.FieldGroup>

{#snippet verificationFields()}
  <Field.Field>
  <Field.FieldLabel for="verification">Requests are trusted when</Field.FieldLabel>
  <ToggleGroup.Root
    type="single"
    variant="outline"
    value={fields.verification}
    onValueChange={(value) => {
        if (value === "hmac-sha256" || value === "secret-header" || value === "standard-webhooks") {
          fields.verification = value;
        }
      }}
    class="w-fit flex-wrap"
  >
      <ToggleGroup.Item value="hmac-sha256" id="verification">The body is signed</ToggleGroup.Item>
      <ToggleGroup.Item value="secret-header">A header carries the secret</ToggleGroup.Item>
      {#if preset?.verification.kind === "standard-webhooks"}
        <!-- Only for a sender that signs this way: its secret is pasted after creating. -->
        <ToggleGroup.Item value="standard-webhooks">Standard Webhooks</ToggleGroup.Item>
      {/if}
    </ToggleGroup.Root>
  <Field.FieldDescription>
      {#if fields.verification === "hmac-sha256"}
        The sender signs each body with the secret (HMAC-SHA256, hex), so a request can't be
        forged or changed on the way.
      {:else if fields.verification === "secret-header"}
        The sender puts the secret itself in a header. For senders that can't sign.
      {:else}
        Signed the Standard Webhooks way. The sender makes the secret, and you paste it in after
        creating.
      {/if}
    </Field.FieldDescription>
</Field.Field>
  {#if fields.verification !== "standard-webhooks"}
    <div class="grid gap-6 sm:grid-cols-2">
  <Field.Field>
    <Field.FieldLabel for="header">Header</Field.FieldLabel>
    <Input id="header" bind:value={fields.header} placeholder={headerPlaceholder} />
    <Field.FieldDescription>
          Leave empty for <code class="font-mono">{headerPlaceholder}</code>.
        </Field.FieldDescription>
  </Field.Field>
  <Field.Field>
    <Field.FieldLabel for="prefix">
          {fields.verification === "hmac-sha256" ? "Signature prefix" : "Value prefix"}
        </Field.FieldLabel>
    <Input id="prefix" bind:value={fields.prefix} placeholder="none" />
    <Field.FieldDescription>
          {#if fields.verification === "hmac-sha256"}
            Text before the hex digest, like <code class="font-mono">sha256=</code>.
          {:else}
            Text before the secret, like <code class="font-mono">Bearer</code> and a space.
          {/if}
        </Field.FieldDescription>
  </Field.Field>
</div>
  {/if}
{/snippet}

{#snippet mappingFields()}
  <Field.FieldSet>
  <div class="grid gap-x-6 gap-y-4 sm:grid-cols-3">
    <Field.Field>
      <Field.FieldLabel for="map-status">Status field</Field.FieldLabel>
      <Input id="map-status" bind:value={fields.mapping.status} placeholder="status"
        class="font-mono" />
    </Field.Field>
    <Field.Field>
      <Field.FieldLabel for="map-key">ID field</Field.FieldLabel>
      <Input id="map-key" bind:value={fields.mapping.key} placeholder="alert.id"
        class="font-mono" />
    </Field.Field>
    <Field.Field>
      <Field.FieldLabel for="map-title">Title field</Field.FieldLabel>
      <Input id="map-title" bind:value={fields.mapping.title} placeholder="alert.name"
        class="font-mono" />
    </Field.Field>
    <Field.Field>
      <Field.FieldLabel for="map-firing">Firing values</Field.FieldLabel>
      <Input id="map-firing" bind:value={fields.mapping.firing} placeholder="firing, triggered" />
    </Field.Field>
    <Field.Field>
      <Field.FieldLabel for="map-resolved">Resolved values</Field.FieldLabel>
      <Input id="map-resolved" bind:value={fields.mapping.resolved} placeholder="resolved, ok" />
    </Field.Field>
    <Field.Field>
      <Field.FieldLabel for="map-update">Update values</Field.FieldLabel>
      <Input id="map-update" bind:value={fields.mapping.update} placeholder="acknowledged" />
    </Field.Field>
  </div>
  <Field.FieldDescription>
      Fields are paths into the JSON body, like <code class="font-mono">alert.id</code>. To try
      several, list them with commas. Requests with the same ID belong together, and an update
      joins an open conversation but never starts one.
    </Field.FieldDescription>
</Field.FieldSet>
{/snippet}
