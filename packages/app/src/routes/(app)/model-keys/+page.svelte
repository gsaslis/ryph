<script lang="ts">
import { can } from "$lib/utils/auth/capabilities";
import PageTitle from "$lib/components/page-title/page-title.svelte";
import { invalidate } from "$app/navigation";
import {
  archiveProviderKey,
  createProviderKey,
  isProviderMissing,
  isSecretRequired,
  updateProviderKey,
} from "$lib/api/provider-keys";
import { archiveProvider, createProvider, getProvider, updateProvider } from "$lib/api/providers";
import { CHATGPT_MANAGE_USAGE_URL, refreshPlanModels } from "$lib/api/chatgpt-plan";
import type { Provider, ProviderDetail, ProviderKey } from "$lib/api/types";
import * as Alert from "$lib/components/ui/alert";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import { pageHeader } from "$lib/components/page-header/page-header.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Card from "$lib/components/ui/card";
import * as Dialog from "$lib/components/ui/dialog";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
import * as Empty from "$lib/components/ui/empty";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Label } from "$lib/components/ui/label";
import { Switch } from "$lib/components/ui/switch";
import ProviderMark from "$lib/components/model-keys/provider-mark.svelte";
import ChatgptSignInDialog from "$lib/components/model-keys/chatgpt-sign-in-dialog.svelte";
import EndpointFields from "$lib/components/model-keys/endpoint-fields.svelte";
import KeySecretFields from "$lib/components/model-keys/key-secret-fields.svelte";
import { planAccountLine, planStatusBadge } from "$lib/components/model-keys/plan-key";
import {
  keyProviderOptions,
  planSignInOffered,
  providerOptionLabel,
} from "$lib/components/model-keys/provider-options";
import * as Select from "$lib/components/ui/select";
import { Spinner } from "$lib/components/ui/spinner";
import * as Table from "$lib/components/ui/table";
import { formatDateTime } from "$lib/utils/format";
import ArchiveIcon from "@lucide/svelte/icons/archive";
import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import LogInIcon from "@lucide/svelte/icons/log-in";
import LogOutIcon from "@lucide/svelte/icons/log-out";
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import MoreHorizontalIcon from "@lucide/svelte/icons/more-horizontal";
import PencilIcon from "@lucide/svelte/icons/pencil";
import PlusIcon from "@lucide/svelte/icons/plus";
import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
import ServerIcon from "@lucide/svelte/icons/server";
import SparklesIcon from "@lucide/svelte/icons/sparkles";
import { toast } from "svelte-sonner";
import {
  composeCreateBody,
  composeUpdateBody,
  endpointFormFor,
  type EndpointFormState,
  endpointShapeChanged,
  newEndpointForm,
} from "$lib/components/model-keys/custom-endpoint-form";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

// Registering, rotating, archiving and the platform's own policy take models:manage: the services
// refuse everyone else, so the page does not offer what would come back a 403. Reading stays.
const canManage = $derived(can(data.user, "models:manage"));

// Where a key can be registered, and whether a ChatGPT plan can be signed in here.
const providerOptions = $derived(keyProviderOptions(data.providers, data.harnesses));
const planAvailable = $derived(planSignInOffered(data.providers));

// ── the key cards ────────────────────────────────────────────────────────────────────────

/** A provider as a person names it: "Anthropic", a custom endpoint's own label. */
const providerName = (id: string) => data.providers.find((p) => p.id === id)?.label ?? id;

// Which live agents use each key, for the line on its card and the archive warning.
const usedBy = $derived.by(() => {
  const byKey = new Map<string, string[]>();
  for (const agent of data.agents) {
    const keyId = agent.modelPolicy?.providerKeyId;
    if (!keyId || agent.archivedAt) continue;
    byKey.set(keyId, [...(byKey.get(keyId) ?? []), agent.name]);
  }
  return byKey;
});

// Archived keys are kept for the record: out of the grid unless asked for, with the switch in the
// bar above the page, as on the agents page.
let showArchived = $state(false);
const archivedCount = $derived(data.providerKeys.filter((k) => k.archivedAt !== null).length);
const keys = $derived(data.providerKeys.filter((k) => showArchived || k.archivedAt === null));
$effect(() => {
  pageHeader.controls = archivedCount > 0 ? archivedSwitch : null;
  return () => {
    pageHeader.controls = null;
  };
});

// ── custom endpoints ────────────────────────────────────────────────────────────────────────
//
// An OpenAI-compatible upstream registered as a row: from then on it is a provider like any
// other. Built-ins are compiled into the proxy and never appear here — there is nothing to edit
// about them and archiving one would be a way to break the deployment.
const customEndpoints = $derived(data.providers.filter((p) => !p.builtin));

let endpointOpen = $state(false);
/** The endpoint being edited, or null while the dialog is registering a new one. */
let endpointTarget: Provider | null = $state(null);
let endpointForm = $state<EndpointFormState>(newEndpointForm());
let savingEndpoint = $state(false);
/** The detail read an edit prefills from: pending while it is in flight, and the reason it
 * failed if it did — the form is not shown in either case (see `openEditEndpoint`). */
let loadingEndpoint = $state(false);
let endpointLoadError: string | null = $state(null);
/** The endpoint as stored, read when the edit dialog opened: what the warning below compares
 * the form against. Null while registering, loading, or after a failed read. */
let endpointStored: ProviderDetail | null = $state.raw(null);
/** How many live keys saving this edit would leave without their secret: the proxy clears them
 * when the address, credential header, scheme or static headers change (`endpointShapeChanged`
 * follows its rule), and a key already waiting for its secret has none to lose. */
const endpointKeysCleared = $derived.by(() => {
  const stored = endpointStored;
  if (stored === null || !endpointShapeChanged(stored, endpointForm)) return 0;
  return data.providerKeys.filter(
    (k) => k.provider === stored.id && k.archivedAt === null && !k.needsSecret,
  ).length;
});

function openNewEndpoint() {
  endpointTarget = null;
  endpointStored = null;
  endpointForm = newEndpointForm();
  endpointLoadError = null;
  endpointOpen = true;
}

/**
 * Editing starts with a read: the provider LIST does not carry an endpoint's static headers, so
 * the dialog fills itself from `GET /v1/providers/:id`, the admin-only route that does.
 *
 * If that read fails, the form stays hidden and the dialog says why. A non-admin cannot reach
 * this control at all, so a 403 here means something is wrong — but the failure that matters is
 * the mundane one: blank fields would look exactly like a stored configuration of nothing, and
 * saving them would write that.
 */
async function openEditEndpoint(provider: Provider) {
  endpointTarget = provider;
  endpointStored = null;
  endpointForm = newEndpointForm();
  endpointLoadError = null;
  loadingEndpoint = true;
  endpointOpen = true;
  try {
    const stored = await getProvider(fetch, provider.id);
    endpointForm = endpointFormFor(stored);
    endpointStored = stored;
  } catch (e) {
    endpointLoadError = e instanceof Error ? e.message : "The endpoint could not be read";
  } finally {
    loadingEndpoint = false;
  }
}

async function submitEndpoint(event: SubmitEvent) {
  event.preventDefault();
  const target = endpointTarget;
  savingEndpoint = true;
  try {
    if (target === null) {
      const composed = composeCreateBody(endpointForm, data.providers);
      if (!composed.ok) {
        toast.error(composed.error);
        return;
      }
      const saved = await createProvider(fetch, composed.body);
      toast.success(`Registered "${saved.label}" — register a key for it next`);
    } else {
      const composed = composeUpdateBody(endpointForm);
      if (!composed.ok) {
        toast.error(composed.error);
        return;
      }
      // The proxy's own count, not the warning's guess: it cleared what it cleared.
      const { provider: saved, keysCleared } = await updateProvider(
        fetch,
        target.id,
        composed.body,
      );
      toast.success(
        keysCleared > 0
          ? `Saved "${saved.label}". ${
            keysCleared === 1 ? "Its key needs its" : `${keysCleared} keys need their`
          } secret again`
          : `Saved "${saved.label}"`,
      );
    }
    endpointOpen = false;
    await invalidate("app:model-keys");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to save the endpoint");
  } finally {
    savingEndpoint = false;
  }
}

let archiveEndpointTarget: Provider | null = $state(null);
let archivingEndpoint = $state(false);

async function submitArchiveEndpoint() {
  if (!archiveEndpointTarget) return;
  archivingEndpoint = true;
  try {
    await archiveProvider(fetch, archiveEndpointTarget.id);
    toast.success(`Archived "${archiveEndpointTarget.label}"`);
    archiveEndpointTarget = null;
    await invalidate("app:model-keys");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to archive the endpoint");
  } finally {
    archivingEndpoint = false;
  }
}

let addOpen = $state(false);
let addProvider = $state("");
let addLabel = $state("");
let addSecret = $state("");
let adding = $state(false);
/** The proxy's words when the endpoint's address changed while saving; the dialog stays open. */
let addSecretError: string | null = $state(null);
const selectedProvider = $derived(providerOptions.find((p) => p.id === addProvider));

async function submitAdd(event: SubmitEvent) {
  event.preventDefault();
  if (!addProvider) {
    toast.error("Pick a provider");
    return;
  }
  adding = true;
  addSecretError = null;
  try {
    const key = await createProviderKey(fetch, {
      provider: addProvider,
      label: addLabel,
      secret: addSecret,
    });
    toast.success(`Registered "${key.label}"`);
    addOpen = false;
    addProvider = "";
    addLabel = "";
    addSecret = "";
    await invalidate("app:model-keys");
  } catch (e) {
    if (isSecretRequired(e)) {
      addSecretError = e.message;
      await invalidate("app:model-keys");
      return;
    }
    toast.error(e instanceof Error ? e.message : "Failed to register key");
  } finally {
    adding = false;
  }
}

let rotateTarget: ProviderKey | null = $state(null);
let rotateSecret = $state("");
let rotating = $state(false);
let rotateSecretError: string | null = $state(null);

function openRotate(key: ProviderKey) {
  rotateTarget = key;
  rotateSecret = "";
  rotateSecretError = null;
}

async function submitRotate(event: SubmitEvent) {
  event.preventDefault();
  if (!rotateTarget) return;
  rotating = true;
  rotateSecretError = null;
  try {
    const fixing = rotateTarget.needsSecret === true;
    const key = await updateProviderKey(fetch, rotateTarget.id, { secret: rotateSecret });
    toast.success(
      fixing
        ? `Saved the key for "${key.label}"`
        : `Rotated "${key.label}" — same key id, new secret`,
    );
    rotateTarget = null;
    rotateSecret = "";
    await invalidate("app:model-keys");
  } catch (e) {
    if (isSecretRequired(e) || isProviderMissing(e)) {
      rotateSecretError = e.message;
      await invalidate("app:model-keys");
      return;
    }
    toast.error(e instanceof Error ? e.message : "Failed to rotate key");
  } finally {
    rotating = false;
  }
}

// ── ChatGPT plan keys ───────────────────────────────────────────────────────────────────────
//
// A plan key is made by signing in, renewed by signing in again, and removed by signing out,
// which is the archive below with its own words.

let signInOpen = $state(false);
/** The plan key being signed in again; null while the dialog adds a new one. */
let signInTarget: ProviderKey | null = $state(null);

/** Bumped on every opening, which mounts the dialog afresh. */
let signInSession = $state(0);

function openSignIn(key: ProviderKey | null) {
  signInSession += 1;
  signInTarget = key;
  signInOpen = true;
}

async function signedIn() {
  toast.success(
    signInTarget === null ? "Signed in with ChatGPT" : `Signed in again to "${signInTarget.label}"`,
  );
  await invalidate("app:model-keys");
}

let refreshingModels: string | null = $state(null);

async function refreshModels(key: ProviderKey) {
  refreshingModels = key.id;
  try {
    const models = await refreshPlanModels(fetch, key.id);
    toast.success(`${models.length} ${models.length === 1 ? "model" : "models"} available`);
    await invalidate("app:model-keys");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to refresh models");
  } finally {
    refreshingModels = null;
  }
}

let archiveTarget: ProviderKey | null = $state(null);
let archiving = $state(false);

async function submitArchive() {
  if (!archiveTarget) return;
  archiving = true;
  try {
    const { revoked } = await archiveProviderKey(fetch, archiveTarget.id);
    if (archiveTarget.plan && revoked === false) {
      // OpenAI did not confirm the sign-out: the person ends it on their side.
      toast.warning("Signed out here. To be sure, disconnect ryph in ChatGPT settings.", {
        duration: 15_000,
        action: {
          label: "Open settings",
          onClick: () => window.open(CHATGPT_MANAGE_USAGE_URL, "_blank", "noopener,noreferrer"),
        },
      });
    } else {
      toast.success(
        archiveTarget.plan
          ? `Signed out of "${archiveTarget.label}"`
          : `Archived "${archiveTarget.label}"`,
      );
    }
    archiveTarget = null;
    await invalidate("app:model-keys");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to remove key");
  } finally {
    archiving = false;
  }
}
</script>

{#snippet planActions(key: ProviderKey)}
  <DropdownMenu.Root>
  <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="ghost" size="icon-sm" aria-label="Plan actions">
          {#if refreshingModels === key.id}
            <Spinner />
          {:else}
            <MoreHorizontalIcon />
          {/if}
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end">
    <DropdownMenu.Group>
      <DropdownMenu.Item>
          {#snippet child({ props })}
            <a {...props} href={CHATGPT_MANAGE_USAGE_URL} target="_blank" rel="noreferrer">
              <ExternalLinkIcon />
              Manage usage
            </a>
          {/snippet}
        </DropdownMenu.Item>
      {#if planAvailable}
        <DropdownMenu.Item onclick={() => openSignIn(key)}>
            <LogInIcon />
            Sign in again
          </DropdownMenu.Item>
        <DropdownMenu.Item disabled={refreshingModels !== null} onclick={() => refreshModels(key)}>
            <RefreshCwIcon />
            Refresh models
          </DropdownMenu.Item>
      {/if}
      <DropdownMenu.Item variant="destructive" onclick={() => (archiveTarget = key)}>
          <LogOutIcon />
          Sign out
        </DropdownMenu.Item>
    </DropdownMenu.Group>
  </DropdownMenu.Content>
</DropdownMenu.Root>
{/snippet}

{#snippet archivedSwitch()}
  <Label for="show-archived" class="text-muted-foreground font-normal">Show archived</Label>
  <Switch id="show-archived" bind:checked={showArchived} />
{/snippet}

<svelte:head>
  <title>Model keys · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-6">
  <PageTitle title="Model keys">
    {#snippet actions()}
      {#if data.modelAccessEnabled && canManage}
        <Button
          onclick={() => {
            addOpen = true;
          }}
        >
          <PlusIcon data-icon="inline-start" />
          Add key
        </Button>
      {/if}
    {/snippet}
    {#snippet description()}
      API keys for the model providers your agents use. Runs never see the keys themselves.
    {/snippet}
  </PageTitle>

  <!-- The platform's own background work spends one of these keys; which one is set with the
       instance's other settings, so an admin is pointed there. -->
  {#if data.modelAccessEnabled && canManage}
    <Alert.Root>
      <SparklesIcon />
      <Alert.Title>Background model</Alert.Title>
      <Alert.Description>
        <span>
          Ryph's own work, like checking memories and reading documents, uses one of these keys.
          <a
            href="/instance/platform#background-model"
            class="text-foreground underline underline-offset-4"
          >
            Choose which in Platform settings
          </a>
        </span>
      </Alert.Description>
    </Alert.Root>
  {/if}

  {#if !data.modelAccessEnabled}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon">
          <KeyRoundIcon />
        </Empty.Media>
        <Empty.Title>Model access is off</Empty.Title>
        <Empty.Description>
          This deployment runs without a master key, so there is nothing to seal secrets with and
          no keys can be registered. Set <code>RYPH_SECRETS_KEY</code> on the host to turn model
          access on.
        </Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {:else}
    <!-- Keys as cards, as agents and tool servers are: the provider is the face, and the line
         that matters before rotating or archiving one is who uses it. -->
    {#if keys.length === 0}
      <Empty.Root class="border border-dashed">
        <Empty.Header>
          <Empty.Media variant="icon"><KeyRoundIcon /></Empty.Media>
          <Empty.Title>No keys yet</Empty.Title>
          <Empty.Description>Add a provider key so agents can call a model.</Empty.Description>
        </Empty.Header>
        {#if canManage}
          <Empty.Content>
            <Button onclick={() => (addOpen = true)}>
              <PlusIcon data-icon="inline-start" />
              Add key
            </Button>
          </Empty.Content>
        {/if}
      </Empty.Root>
    {:else}
      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {#each keys as key (key.id)}
          {@const users = usedBy.get(key.id) ?? []}
          <Card.Root
            size="sm"
            class={[
              "@container/card from-foreground/5 to-card bg-linear-to-t",
              key.archivedAt && "opacity-60",
            ]}
          >
            <Card.Header>
              <div class="flex min-w-0 flex-col gap-4">
                <ProviderMark provider={key.provider} label={providerName(key.provider)} />
                <Card.Title class="truncate" title={key.label}>{key.label}</Card.Title>
              </div>
              <Card.Action class="flex items-center gap-1">
                {#if key.archivedAt}
                  <Badge variant="outline">{key.plan ? "Signed out" : "Archived"}</Badge>
                {:else if key.plan}
                  {@const badge = planStatusBadge(key.plan.status)}
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                {:else if key.providerMissing}
                  <Badge variant="destructive">Provider gone</Badge>
                {:else if key.needsSecret}
                  <Badge variant="destructive">Needs its key again</Badge>
                {:else}
                  <Badge variant="secondary">{providerName(key.provider)}</Badge>
                {/if}
                {#if canManage && !key.archivedAt && key.plan}
                  {@render planActions(key)}
                {:else if canManage && !key.archivedAt}
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger>
                      {#snippet child({ props })}
                        <Button {...props} variant="ghost" size="icon-sm" aria-label="Key actions">
                          <MoreHorizontalIcon />
                        </Button>
                      {/snippet}
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content align="end">
                      <DropdownMenu.Group>
                        {#if !key.providerMissing}
                          <DropdownMenu.Item onclick={() => openRotate(key)}>
                            <RefreshCwIcon />
                            {key.needsSecret ? "Enter key again" : "Replace secret"}
                          </DropdownMenu.Item>
                        {/if}
                        <DropdownMenu.Item
                          variant="destructive"
                          onclick={() => (archiveTarget = key)}
                        >
                          <ArchiveIcon />
                          Archive
                        </DropdownMenu.Item>
                      </DropdownMenu.Group>
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                {/if}
              </Card.Action>
            </Card.Header>
            <Card.Content class="mt-auto flex flex-col gap-1">
              {#if key.plan}
                {@const account = planAccountLine(key.plan)}
                <Card.Description class="truncate text-xs" title={account ?? undefined}>
                  ChatGPT plan{account ? ` · ${account}` : ""}
                </Card.Description>
                {#if !key.archivedAt && !planAvailable}
                  <Card.Description class="text-destructive text-xs">
                    Only works when Ryph runs on your own machine.
                  </Card.Description>
                {:else if !key.archivedAt && key.plan.status === "needs_reauth"}
                  <Card.Description class="text-destructive text-xs">
                    Runs using it fail until someone signs in again.
                  </Card.Description>
                {:else if !key.archivedAt && key.plan.status === "limited"}
                  <Card.Description class="text-xs">
                    Review your plan's limit in
                    <a
                      href={CHATGPT_MANAGE_USAGE_URL}
                      target="_blank"
                      rel="noreferrer"
                      class="text-foreground underline underline-offset-4"
                    >
                      ChatGPT settings</a
                    >.
                  </Card.Description>
                {:else}
                  <Card.Description class="text-xs">
                    {key.plan.models.length}
                    {key.plan.models.length === 1 ? "model" : "models"} included
                  </Card.Description>
                {/if}
              {:else if key.providerMissing && !key.archivedAt}
                <!-- Nothing to send it to, and nothing to bind a new secret to: archive it. -->
                <Card.Description class="text-destructive text-xs">
                  Its provider no longer exists. Runs can't use it; archive it.
                </Card.Description>
              {:else if key.needsSecret && !key.archivedAt}
                <!-- Its endpoint changed, and the secret was bound to the old one. -->
                <Card.Description class="text-destructive text-xs">
                  Runs can't use it until the key is entered again.
                </Card.Description>
                {#if canManage}
                  <Button
                    variant="outline"
                    size="sm"
                    class="my-1 self-start"
                    onclick={() => openRotate(key)}
                  >
                    <KeyRoundIcon data-icon="inline-start" />
                    Enter key again
                  </Button>
                {/if}
              {:else}
                <Card.Description class="font-mono text-xs">····{key.last4}</Card.Description>
              {/if}
              <Card.Description class="truncate text-xs" title={users.join(", ")}>
                {users.length === 0
                  ? "Not used by any agent"
                  : users.length <= 2
                  ? `Used by ${users.join(" and ")}`
                  : `Used by ${users.length} agents`}
              </Card.Description>
            </Card.Content>
          </Card.Root>
        {/each}
        {#if canManage}
          <button
            type="button"
            onclick={() => (addOpen = true)}
            class="text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:ring-ring/50 flex min-h-40 items-center justify-center gap-2 rounded-xl border border-dashed text-sm transition-colors outline-none focus-visible:ring-[3px]"
          >
            <PlusIcon class="size-4" />
            Add key
          </button>
        {/if}
      </div>
    {/if}

    <!-- The ChatGPT plan: a sign-in rather than a pasted key. Once signed in, the plan is a key
         card above like any other. -->
    {#if canManage && planAvailable}
      <section class="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
        <div class="flex flex-col gap-1">
          <h2 class="text-base font-medium">Use your ChatGPT plan</h2>
          <p class="text-muted-foreground text-sm">
            Run agents on the usage included in your ChatGPT plan instead of paying API prices.
          </p>
        </div>
        <Button variant="outline" onclick={() => openSignIn(null)}>Continue with ChatGPT</Button>
      </section>
    {/if}

    <!-- Custom providers: the advanced case, so a compact list under the keys. Once registered,
         one is a provider like any other, and its keys join the cards above. -->
    <section class="flex flex-col gap-3">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div class="flex flex-col gap-1">
          <h2 class="text-base font-medium">Custom providers</h2>
          <p class="text-muted-foreground text-sm">
            Any OpenAI-compatible endpoint, like Groq, OpenRouter or a self-hosted vLLM.
          </p>
        </div>
        {#if canManage}
          <Button variant="outline" size="sm" onclick={openNewEndpoint}>
            <PlusIcon data-icon="inline-start" />
            Add endpoint
          </Button>
        {/if}
      </div>
      {#if customEndpoints.length > 0}
        <ul class="divide-y rounded-lg border text-sm">
          {#each customEndpoints as endpoint (endpoint.id)}
            <li
              class={[
                "flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5",
                endpoint.archivedAt && "opacity-60",
              ]}
            >
              <span class="font-medium">{endpoint.label}</span>
              <span
                class="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs"
                title={endpoint.baseUrl}
              >
                {endpoint.baseUrl.replace(/^https?:\/\//, "")}
              </span>
              <span class="text-muted-foreground text-xs">
                {endpoint.models.length}
                {endpoint.models.length === 1 ? "model" : "models"}
              </span>
              {#if endpoint.archivedAt}
                <Badge variant="outline">Archived</Badge>
              {:else if canManage}
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger>
                    {#snippet child({ props })}
                      <Button {...props} variant="ghost" size="icon-sm" aria-label="Endpoint actions">
                        <MoreHorizontalIcon />
                      </Button>
                    {/snippet}
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Content align="end">
                    <DropdownMenu.Group>
                      <DropdownMenu.Item onclick={() => openEditEndpoint(endpoint)}>
                        <PencilIcon />
                        Edit
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        variant="destructive"
                        onclick={() => (archiveEndpointTarget = endpoint)}
                      >
                        <ArchiveIcon />
                        Archive
                      </DropdownMenu.Item>
                    </DropdownMenu.Group>
                  </DropdownMenu.Content>
                </DropdownMenu.Root>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

</div>

{#key signInSession}
  <ChatgptSignInDialog
  bind:open={signInOpen}
  keyId={signInTarget?.id}
  keyLabel={signInTarget?.label}
  onDone={signedIn}
/>
{/key}

<Dialog.Root
  bind:open={addOpen}
  onOpenChange={(open) => {
    if (!open) addSecretError = null;
  }}
>
  <Dialog.Content>
    <form onsubmit={submitAdd}>
      <Dialog.Header>
        <Dialog.Title>Add a provider key</Dialog.Title>
        <Dialog.Description>
          The secret is sealed on arrival and never shown again — only its last four characters
          remain visible.
        </Dialog.Description>
      </Dialog.Header>
      <Field.FieldGroup class="py-4">
        <Field.Field>
          <Field.FieldLabel for="add-provider">Provider</Field.FieldLabel>
          <Select.Root type="single" bind:value={addProvider}>
            <Select.Trigger id="add-provider" class="w-full">
              {selectedProvider ? providerOptionLabel(selectedProvider) : "Select a provider"}
            </Select.Trigger>
            <Select.Content>
              <Select.Group>
                {#each providerOptions as provider (provider.id)}
                  <Select.Item value={provider.id} label={providerOptionLabel(provider)} />
                {/each}
              </Select.Group>
            </Select.Content>
          </Select.Root>
          {#if canManage}
            <Field.FieldDescription>
              Not listed?
              <button
                type="button"
                class="text-foreground underline underline-offset-4"
                onclick={() => {
                  addOpen = false;
                  openNewEndpoint();
                }}
              >
                Add a custom provider
              </button>
            </Field.FieldDescription>
          {/if}
          <Field.FieldDescription>
            The two built-ins and every custom endpoint registered above. Register the endpoint
            first; the key is what authenticates to it.
          </Field.FieldDescription>
        </Field.Field>
        <KeySecretFields bind:label={addLabel} bind:secret={addSecret} />
        {#if addSecretError}
          <Field.FieldError>{addSecretError}</Field.FieldError>
        {/if}
      </Field.FieldGroup>
      <Dialog.Footer>
        <Button
          type="button"
          variant="ghost"
          onclick={() => {
            addOpen = false;
          }}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={adding}>
          {#if adding}
            <Spinner data-icon="inline-start" />
          {:else}
            <PlusIcon data-icon="inline-start" />
          {/if}
          Register key
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root
  open={rotateTarget !== null}
  onOpenChange={(open) => {
    if (!open) rotateTarget = null;
  }}
>
  <Dialog.Content>
    <form onsubmit={submitRotate}>
      <Dialog.Header>
        {#if rotateTarget?.needsSecret}
          <Dialog.Title>Enter the key for "{rotateTarget.label}" again</Dialog.Title>
          <Dialog.Description>
            Its endpoint changed, so the key was cleared. No agent needs re-assigning.
          </Dialog.Description>
        {:else}
          <Dialog.Title>Replace the secret of "{rotateTarget?.label}"</Dialog.Title>
          <Dialog.Description>
            Replaces the secret under the same key id — no agent needs re-assigning. Runs already
            in flight keep working; new runs use the new secret.
          </Dialog.Description>
        {/if}
      </Dialog.Header>
      <Field.FieldGroup class="py-4">
        <Field.Field>
          <Field.FieldLabel for="rotate-secret">New API key</Field.FieldLabel>
          <Input
            id="rotate-secret"
            type="password"
            required
            bind:value={rotateSecret}
            placeholder="sk-ant-…"
            autocomplete="off"
          />
          {#if rotateSecretError}
            <Field.FieldError>{rotateSecretError}</Field.FieldError>
          {/if}
        </Field.Field>
      </Field.FieldGroup>
      <Dialog.Footer>
        <Button
          type="button"
          variant="ghost"
          onclick={() => {
            rotateTarget = null;
          }}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={rotating}>
          {#if rotating}
            <Spinner data-icon="inline-start" />
          {:else}
            <RefreshCwIcon data-icon="inline-start" />
          {/if}
          {rotateTarget?.needsSecret ? "Save key" : "Rotate secret"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<AlertDialog.Root
  open={archiveTarget !== null}
  onOpenChange={(open) => {
    if (!open) archiveTarget = null;
  }}
>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>
        {archiveTarget?.plan ? "Sign out of" : "Archive"} "{archiveTarget?.label}"?
      </AlertDialog.Title>
      <AlertDialog.Description>
        {#if archiveTarget?.plan}
          Runs using this plan stop working right away, including runs in progress.
        {:else}
          Every run using it loses model access right away, including runs in progress.
        {/if}
        {#if archiveTarget && (usedBy.get(archiveTarget.id) ?? []).length > 0}
          {@const users = usedBy.get(archiveTarget.id) ?? []}
          {users.join(", ")}
          {users.length === 1 ? "needs" : "need"} another key before {users.length === 1
            ? "its"
            : "their"} next run.
        {/if}
        {archiveTarget?.plan
        ? "To use the plan again, sign in with ChatGPT."
        : "The key is kept for the record."}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action disabled={archiving} onclick={submitArchive}>
        {#if archiving}
          <Spinner data-icon="inline-start" />
        {/if}
        {archiveTarget?.plan ? "Sign out" : "Archive key"}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<!-- Register or edit a custom endpoint. One dialog for both: the only difference is that the slug
     is fixed once anything references it, and that an edit has to read the endpoint in full
     before it can show anything — the list it was opened from does not carry the headers. -->
<Dialog.Root bind:open={endpointOpen}>
  <Dialog.Content class="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
    <form onsubmit={submitEndpoint}>
      <Dialog.Header>
        <Dialog.Title>
          {endpointTarget === null ? "Add a custom endpoint" : `Edit "${endpointTarget.label}"`}
        </Dialog.Title>
        <Dialog.Description>
          Anything that speaks the OpenAI chat-completions API. Paste the base URL its own client
          library would be given — for Cloudflare Workers AI that is
          <code>https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1</code>, for Groq
          <code>https://api.groq.com/openai/v1</code>. No credential is set here: that is a
          provider key, registered against this endpoint and sealed in the proxy.
        </Dialog.Description>
      </Dialog.Header>
      {#if endpointLoadError !== null}
        <!-- An edit prefills from the detail read; if that read did not come back, the form
             below would show its own blank defaults, which look exactly like a stored
             configuration of nothing and would be saved as one. So it is not shown at all. -->
        <Alert.Root variant="destructive" class="my-4 gap-2">
          <CircleAlertIcon />
          <Alert.Title class="text-xs font-medium tracking-wider uppercase">
            Could not read this endpoint
          </Alert.Title>
          <Alert.Description>
            {endpointLoadError}. Nothing is shown, because empty fields here are not what is
            stored — saving them would overwrite the real headers and models. Close this and try
            again.
          </Alert.Description>
        </Alert.Root>
      {:else if loadingEndpoint}
        <div class="text-muted-foreground flex items-center gap-2 py-10 text-sm">
          <Spinner />
          Reading what is stored…
        </div>
      {:else}
        <EndpointFields bind:form={endpointForm} editing={endpointTarget !== null} class="py-4" />
        {#if endpointKeysCleared > 0}
          <Alert.Root class="mb-4">
            <CircleAlertIcon />
            <Alert.Description>
              Changing the address or headers clears {endpointKeysCleared === 1
                ? "this endpoint's key"
                : `this endpoint's ${endpointKeysCleared} keys`}. You'll enter {endpointKeysCleared === 1 ? "it" : "them"} again.
            </Alert.Description>
          </Alert.Root>
        {/if}
      {/if}
      <Dialog.Footer>
        <Button
          type="button"
          variant="ghost"
          onclick={() => {
            endpointOpen = false;
          }}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={savingEndpoint || loadingEndpoint || endpointLoadError !== null}
        >
          {#if savingEndpoint}
            <Spinner data-icon="inline-start" />
          {:else if endpointTarget === null}
            <PlusIcon data-icon="inline-start" />
          {:else}
            <PencilIcon data-icon="inline-start" />
          {/if}
          {endpointTarget === null ? "Register endpoint" : "Save changes"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<AlertDialog.Root
  open={archiveEndpointTarget !== null}
  onOpenChange={(open) => {
    if (!open) archiveEndpointTarget = null;
  }}
>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Archive "{archiveEndpointTarget?.label}"?</AlertDialog.Title>
      <AlertDialog.Description>
        This is the kill switch for the whole endpoint: every key registered against it stops
        minting credentials, and runs already in flight — including ones mid-request — lose model
        access immediately. Agents pointed at one of those keys must be re-assigned before their
        next run. Archived endpoints are kept so past runs and usage still resolve, never deleted.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action disabled={archivingEndpoint} onclick={submitArchiveEndpoint}>
        {#if archivingEndpoint}
          <Spinner data-icon="inline-start" />
        {/if}
        Archive endpoint
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
