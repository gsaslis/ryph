<script lang="ts">
import { goto, invalidate, pushState } from "$app/navigation";
import { page } from "$app/state";
import { createAgent } from "$lib/api/agents";
import { createProviderKey, setPlatformModelPolicy } from "$lib/api/provider-keys";
import { createProvider } from "$lib/api/providers";
import { connectLocalRepo } from "$lib/api/repos";
import type { Agent, ConnectedRepo, Provider, ProviderKey } from "$lib/api/types";
import AgentAvatar from "$lib/components/agent-avatar/agent-avatar.svelte";
import ForgeIcon from "$lib/components/forge-icon/forge-icon.svelte";
import ChatgptSignInDialog from "$lib/components/model-keys/chatgpt-sign-in-dialog.svelte";
import {
  composeCreateBody,
  type EndpointFormState,
  newEndpointForm,
} from "$lib/components/model-keys/custom-endpoint-form";
import EndpointFields from "$lib/components/model-keys/endpoint-fields.svelte";
import KeySecretFields from "$lib/components/model-keys/key-secret-fields.svelte";
import { planAccountLine } from "$lib/components/model-keys/plan-key";
import ProviderMark from "$lib/components/model-keys/provider-mark.svelte";
import { keyProviderOptions, planSignInOffered } from "$lib/components/model-keys/provider-options";
import ModelSelect from "$lib/components/model-picker/model-select.svelte";
import { modelsForKey } from "$lib/components/model-picker/models";
import PickCard from "$lib/components/pick-card/pick-card.svelte";
import PickGrid from "$lib/components/pick-card/pick-grid.svelte";
import RyphBlob from "$lib/components/ryph-blob/ryph-blob.svelte";
import SteppedFlow, { type FlowStepItem } from "$lib/components/stepped-flow/stepped-flow.svelte";
import { stepOf } from "$lib/components/stepped-flow/steps";
import * as Alert from "$lib/components/ui/alert";
import { Button } from "$lib/components/ui/button";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select";
import { Spinner } from "$lib/components/ui/spinner";
import { agentAvatar } from "$lib/utils/avatar";
import { localRepoName, shortenRid } from "$lib/utils/forge";
import { withBackTo } from "$lib/utils/safe-path";
import { markWelcomeDone } from "$lib/utils/welcome";
import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
import FolderGit2Icon from "@lucide/svelte/icons/folder-git-2";
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import PlayIcon from "@lucide/svelte/icons/play";
import PlusIcon from "@lucide/svelte/icons/plus";
import ServerIcon from "@lucide/svelte/icons/server";
import SproutIcon from "@lucide/svelte/icons/sprout";
import { toast } from "svelte-sonner";
import { usableProviderKeys } from "../agents/shared/model-policy";
import {
  localRepoFailure,
  pathProblem,
  withoutTrailingSlash,
} from "../repos/connect/local/refusal";
import ImageDownloads from "./image-downloads.svelte";
import {
  backgroundProviderKeys,
  composeQuickAgent,
  DEFAULT_AGENT_NAME,
  defaultHarnessKind,
  firstOpenStep,
  newestId,
  newTaskHref,
  WELCOME_STEPS,
  type WelcomeStepId,
} from "./welcome";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const liveKeys = $derived(data.providerKeys.filter((key) => key.archivedAt === null));
const done = $derived({
  model: liveKeys.length > 0,
  agent: data.agents.length > 0,
  background: data.platformPolicy !== null,
  repo: data.connectedRepos.length > 0,
});

// The step on screen lives in the history entry's state, as in the agent flow, so the browser's
// back button walks the steps. Without one it is the step the address names (a flow this one
// sent somewhere comes back to `?step=`), else the first one not done when the page opened. An
// address naming no step opens there too.
// svelte-ignore state_referenced_locally
const opening = firstOpenStep(done);
const addressed = $derived(page.url.searchParams.get("step"));
const current = $derived(
  stepOf(
    page.state,
    WELCOME_STEPS,
    WELCOME_STEPS.some((step) => step.id === addressed) ? addressed : opening,
  ),
);
const index = $derived(WELCOME_STEPS.findIndex((step) => step.id === current));

const steps = $derived<FlowStepItem[]>(WELCOME_STEPS.map((step) => ({
  ...step,
  status: step.id !== "ready" && done[step.id] ? "done" : "todo",
})));

function go(id: WelcomeStepId) {
  if (id !== current) pushState("", { step: id });
}

function next() {
  const step = WELCOME_STEPS[index + 1];
  if (step) go(step.id);
}

function back() {
  const step = WELCOME_STEPS[index - 1];
  if (step) go(step.id);
}

/** Where another flow returns to, to land back on this step. */
const returnHere = (step: WelcomeStepId) => `/welcome?step=${step}`;

/** Leaving the flow, by finishing it or skipping it, means it is not shown again. */
function leave() {
  markWelcomeDone();
}

async function skipSetup() {
  leave();
  await goto("/agents");
}

const refresh = () => invalidate("app:welcome");

// ── model ──────────────────────────────────────────────────────────────────────────────────

const PLAN = "chatgpt";
const CUSTOM = "custom";

const planAvailable = $derived(planSignInOffered(data.providers));
const providerOptions = $derived(keyProviderOptions(data.providers, data.harnesses));

type ModelChoice = { id: string; title: string; meta: string; provider: Provider | null };
const modelChoices = $derived<ModelChoice[]>([
  ...(planAvailable
    ? [{ id: PLAN, title: "ChatGPT plan", meta: "Sign in with your account", provider: null }]
    : []),
  ...providerOptions.map((provider) => ({
    id: provider.id,
    title: provider.label,
    meta: "API key",
    provider,
  })),
  { id: CUSTOM, title: "Other provider", meta: "Any OpenAI-compatible API", provider: null },
]);

// The way in picked: the plan, a provider's API key, or a new endpoint and its key. Nothing is
// picked until someone does, so the step opens on the choice.
let modelChoice = $state("");
let addingKey = $state(false);
const showKeyForm = $derived(!done.model || addingKey);
const chosenProvider = $derived(providerOptions.find((p) => p.id === modelChoice));
let keyLabel = $state("");
let keySecret = $state("");
let endpointForm = $state<EndpointFormState>(newEndpointForm());
let savingKey = $state(false);

function chooseModel(id: string) {
  modelChoice = id;
  const provider = providerOptions.find((p) => p.id === id);
  keyLabel = provider ? `${provider.label} key` : "";
}

function secretPlaceholder(provider: Provider | undefined): string {
  if (provider?.id === "anthropic") return "sk-ant-…";
  if (provider?.id === "openai") return "sk-…";
  return "Paste the key";
}

/** A key is there now: it is the one the agent gets, and the flow moves on. */
async function keyAdded(keyId: string) {
  agentKeyId = keyId;
  addingKey = false;
  modelChoice = "";
  keySecret = "";
  endpointForm = newEndpointForm();
  await refresh();
  go("agent");
}

async function addKey() {
  if (modelChoice === CUSTOM) {
    const composed = composeCreateBody(endpointForm, data.providers);
    if (!composed.ok) {
      toast.error(composed.error);
      return;
    }
    if (keySecret.trim() === "") {
      toast.error("Paste the endpoint's API key");
      return;
    }
    savingKey = true;
    try {
      const endpoint = await createProvider(fetch, composed.body);
      const key = await createProviderKey(fetch, {
        provider: endpoint.id,
        label: `${endpoint.label} key`,
        secret: keySecret,
      });
      toast.success(`Added ${endpoint.label}`);
      await keyAdded(key.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't add the endpoint");
      // The endpoint may be there without its key: read it again, so it is offered by name.
      await refresh();
    } finally {
      savingKey = false;
    }
    return;
  }
  if (!chosenProvider) return;
  if (keyLabel.trim() === "" || keySecret.trim() === "") {
    toast.error("Give the key a label and paste the key");
    return;
  }
  savingKey = true;
  try {
    const key = await createProviderKey(fetch, {
      provider: chosenProvider.id,
      label: keyLabel.trim(),
      secret: keySecret,
    });
    toast.success(`Added "${key.label}"`);
    await keyAdded(key.id);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Couldn't add the key");
  } finally {
    savingKey = false;
  }
}

let signInOpen = $state(false);
/** Bumped on every opening, which mounts the dialog afresh. */
let signInSession = $state(0);

function openSignIn() {
  signInSession += 1;
  signInOpen = true;
}

async function signedIn(keyId: string) {
  toast.success("Signed in with ChatGPT");
  await keyAdded(keyId);
}

const providerName = (id: string) => data.providers.find((p) => p.id === id)?.label ?? id;

function keyLine(key: ProviderKey): string {
  if (key.plan) return planAccountLine(key.plan) ?? "ChatGPT plan";
  return `${providerName(key.provider)} ····${key.last4}`;
}

// ── agent ──────────────────────────────────────────────────────────────────────────────────

// The agent the first task runs with: the newest there is, or the one made here.
// svelte-ignore state_referenced_locally
let agentId = $state(newestId(data.agents));
let addingAgent = $state(false);
const showAgentForm = $derived(!done.agent || addingAgent);
let agentName = $state(DEFAULT_AGENT_NAME);
// The harness is the full flow's: pi, unless this deployment does not offer it.
const harnessKind = $derived(defaultHarnessKind(data.harnesses));
const harness = $derived(data.harnesses.find((h) => h.kind === harnessKind));
const agentKeys = $derived(usableProviderKeys(data.providerKeys, data.providers, harness));
// The key the agent spends: the one added here, else the newest it can use.
// svelte-ignore state_referenced_locally
let agentKeyId = $state(newestId(usableProviderKeys(data.providerKeys, data.providers, undefined)));
// A key the harness cannot drive is not offered; the first one it can is used instead.
const agentKey = $derived(agentKeys.find((key) => key.id === agentKeyId) ?? agentKeys[0]);
// The model picked, kept with the key it was picked for: a model is one provider's, so whenever
// the key in use changes, for whatever reason, the agent goes back to that key's default.
let modelPick = $state({ keyId: "", model: "" });
const agentModel = $derived(modelPick.keyId === agentKey?.id ? modelPick.model : "");
const agentModels = $derived(modelsForKey(data.providers, agentKey));
let creatingAgent = $state(false);

function chooseAgentKey(id: string) {
  agentKeyId = id;
}

async function createQuickAgent() {
  if (agentName.trim() === "") {
    toast.error("Give the agent a name");
    return;
  }
  if (!agentKey) {
    toast.error("Pick the model key the agent uses");
    return;
  }
  creatingAgent = true;
  try {
    const agent = await createAgent(
      fetch,
      composeQuickAgent({
        name: agentName,
        providerKeyId: agentKey.id,
        defaultModel: agentModel,
        harnessKind,
        harness,
        providerKeys: data.providerKeys,
        user: data.user,
        host: page.url.hostname,
      }),
    );
    toast.success(`Created ${agent.name}`);
    agentId = agent.id;
    addingAgent = false;
    await refresh();
    go("background");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Couldn't create the agent");
  } finally {
    creatingAgent = false;
  }
}

const selectedAgent = $derived(data.agents.find((agent) => agent.id === agentId));

// ── background model ───────────────────────────────────────────────────────────────────────

const backgroundKeys = $derived(backgroundProviderKeys(data.providerKeys, data.providers));
// Keep edits local while other steps refresh their data. Existing policy is never saved implicitly.
// svelte-ignore state_referenced_locally
let backgroundKeyId = $state(data.platformPolicy?.providerKeyId ?? "");
const backgroundKey = $derived(
  backgroundKeys.find((key) => key.id === backgroundKeyId) ??
    backgroundKeys.find((key) => key.id === agentKey?.id) ?? backgroundKeys[0],
);
// svelte-ignore state_referenced_locally
let backgroundPick = $state({
  keyId: data.platformPolicy?.providerKeyId ?? "",
  model: data.platformPolicy?.model ?? "",
});
const backgroundModel = $derived(
  backgroundPick.keyId === backgroundKey?.id ? backgroundPick.model : "",
);
const backgroundModels = $derived(modelsForKey(data.providers, backgroundKey));
let savingBackground = $state(false);

async function saveBackground() {
  if (savingBackground) return;
  if (!backgroundKey || !backgroundModel.trim()) {
    toast.error("Pick a provider key and model for background work");
    return;
  }
  savingBackground = true;
  try {
    await setPlatformModelPolicy(fetch, {
      providerKeyId: backgroundKey.id,
      model: backgroundModel.trim(),
      allowedModels: "*",
    });
    toast.success("Background model saved");
    await refresh();
    go("repo");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Couldn't save the background model");
  } finally {
    savingBackground = false;
  }
}

// ── repository ─────────────────────────────────────────────────────────────────────────────

// svelte-ignore state_referenced_locally
let repoId = $state(newestId(data.connectedRepos));
let addingRepo = $state(false);
const showRepoForm = $derived(!done.repo || addingRepo);
const forgeProviders = $derived(data.forges?.providers ?? []);
const localOffered = $derived(forgeProviders.includes("local"));
const githubLogin = $derived(
  data.forges?.github?.mode === "user" ? data.forges.github.login : null,
);
// The other ways in, each through its own connect flow, which comes back here once it is done.
const repoBack = returnHere("repo");
const otherWays = $derived([
  ...(forgeProviders.includes("github")
    ? [{
      id: "github",
      href: withBackTo(
        githubLogin ? "/repos/connect/github" : "/repos/connect?provider=github",
        repoBack,
      ),
      title: githubLogin ? "From your GitHub" : "GitHub",
      meta: githubLogin
        ? `As @${githubLogin}. Work arrives as pull requests.`
        : "Work arrives as pull requests.",
    }]
    : []),
  ...(data.forges?.gitlab
    ? [{
      id: "gitlab",
      href: withBackTo("/repos/connect/gitlab", repoBack),
      title: data.forges.gitlab.mode === "user" ? "From your GitLab" : "GitLab",
      meta: `As @${data.forges.gitlab.login}. Work arrives as merge requests.`,
    }]
    : []),
  ...(forgeProviders.includes("radicle")
    ? [{
      id: "radicle",
      href: withBackTo("/repos/connect/radicle", repoBack),
      title: "Radicle",
      meta: "By repository id. Work arrives as patches.",
    }]
    : []),
]);

let localPath = $state("");
let addingLocal = $state(false);
/** The server's answer about the last path sent, until the path changes (see the local flow). */
let refusal = $state<{ path: string; message: string } | null>(null);
const localProblem = $derived(
  pathProblem(localPath) ?? (refusal && refusal.path === localPath ? refusal.message : null),
);

async function addLocalRepo() {
  const submitted = localPath;
  const trimmed = withoutTrailingSlash(submitted.trim());
  if (trimmed === "") {
    toast.error("Paste the repository's folder path");
    return;
  }
  if (pathProblem(trimmed)) return;
  addingLocal = true;
  refusal = null;
  try {
    const repo = await connectLocalRepo(fetch, trimmed);
    toast.success(`Added ${localRepoName(repo.repoRef)}`);
    repoId = repo.id;
    addingRepo = false;
    localPath = "";
    await refresh();
    go("ready");
  } catch (e) {
    const failure = localRepoFailure(e);
    if (failure.pinned) refusal = { path: submitted, message: failure.message };
    else toast.error(failure.message);
  } finally {
    addingLocal = false;
  }
}

function repoTitle(repo: ConnectedRepo): string {
  if (repo.provider === "radicle") return shortenRid(repo.repoRef);
  if (repo.provider === "local") return localRepoName(repo.repoRef);
  return repo.repoRef.split("/").at(-1) ?? repo.repoRef;
}

const selectedRepo = $derived(data.connectedRepos.find((repo) => repo.id === repoId));

// ── ready ──────────────────────────────────────────────────────────────────────────────────

let downloading = $state(false);
// The key the summary names: the chosen agent's, else the one picked here, else any.
const readyKey = $derived(
  liveKeys.find((key) => key.id === selectedAgent?.modelPolicy?.providerKeyId) ??
    agentKey ?? liveKeys[0],
);

async function startTask() {
  leave();
  await goto(selectedAgent ? newTaskHref(agentId, selectedRepo ? repoId : "") : "/agents");
}

// ── the footer ─────────────────────────────────────────────────────────────────────────────

/** The step's own action, which Enter in a field runs too; null where there is none to take. */
const action = $derived.by((): { label: string; busy: boolean } | null => {
  switch (current) {
    case "model":
      if (showKeyForm && (chosenProvider || modelChoice === CUSTOM)) {
        return { label: "Add key", busy: savingKey };
      }
      return null;
    case "agent":
      return showAgentForm && agentKeys.length > 0
        ? { label: "Create agent", busy: creatingAgent }
        : null;
    case "background":
      return data.modelAccessEnabled && !data.unread.background && backgroundKeys.length > 0
        ? { label: "Save background model", busy: savingBackground }
        : null;
    case "repo":
      return showRepoForm && localOffered ? { label: "Add repository", busy: addingLocal } : null;
    case "ready":
      return null;
  }
});
const stepDone = $derived(current !== "ready" && done[current]);

function submit(event: SubmitEvent) {
  event.preventDefault();
  if (current === "ready") {
    void startTask();
    return;
  }
  if (action === null) {
    next();
    return;
  }
  if (current === "model") void addKey();
  else if (current === "agent") void createQuickAgent();
  else if (current === "background") void saveBackground();
  else if (current === "repo") void addLocalRepo();
}
</script>

<svelte:head>
  <title>Welcome · Ryph</title>
</svelte:head>

{#snippet modelCard(choice: ModelChoice)}
  <PickCard value={choice.id}>
    {#snippet media()}
      {#if choice.id === CUSTOM}
        <span class="bg-background ring-border flex size-8 items-center justify-center rounded-md ring-1">
          <ServerIcon class="size-4" />
        </span>
      {:else}
        <ProviderMark
          provider={choice.provider?.id ?? choice.id}
          label={choice.title}
          class="size-8 rounded-md [&_span]:text-sm [&_svg]:size-4"
        />
      {/if}
    {/snippet}
    {#snippet title()}
      {choice.title}
    {/snippet}
    {#snippet meta()}
      {choice.meta}
    {/snippet}
  </PickCard>
{/snippet}

{#snippet agentCard(agent: Agent)}
  <PickCard value={agent.id} tint={agentAvatar(agent.id).color}>
    {#snippet media()}
      <AgentAvatar agentId={agent.id} />
    {/snippet}
    {#snippet title()}
      {agent.name}
    {/snippet}
    {#snippet meta()}
      {agent.handle ? `@${agent.handle}` : agent.email}
    {/snippet}
  </PickCard>
{/snippet}

{#snippet repoCard(repo: ConnectedRepo)}
  <PickCard value={repo.id}>
    {#snippet media()}
      <span class="bg-background ring-border flex size-8 items-center justify-center rounded-md ring-1">
        <ForgeIcon provider={repo.provider} />
      </span>
    {/snippet}
    {#snippet title()}
      {repoTitle(repo)}
    {/snippet}
    {#snippet meta()}
      <span class={repo.provider !== "github" && repo.provider !== "gitlab" ? "font-mono" : undefined}>
        {repo.repoRef}
      </span>
    {/snippet}
  </PickCard>
{/snippet}

{#snippet unreadAlert(what: string)}
  <Alert.Root variant="destructive">
  <CircleAlertIcon />
  <Alert.Title>Couldn't load your {what}</Alert.Title>
  <Alert.Description>Reload the page to try again.</Alert.Description>
</Alert.Root>
{/snippet}

{#snippet addAnother(label: string, onclick: () => void)}
  <Button type="button" variant="outline" size="sm" class="self-start" {onclick}>
    <PlusIcon data-icon="inline-start" />
    {label}
  </Button>
{/snippet}

<form onsubmit={submit} novalidate class="contents">
  <SteppedFlow
    title="Welcome to Ryph"
    cancelHref="/agents"
    oncancel={leave}
    {steps}
    {current}
    select={(id) => go(id as WelcomeStepId)}
  >
    {#snippet children(shown: string)}
      <!-- Model -->
      <div hidden={shown !== "model"} class="flex max-w-2xl flex-col gap-8">
        {#if data.unread.keys}
          {@render unreadAlert("model keys")}
        {/if}
        {#if !data.modelAccessEnabled}
          <Alert.Root>
            <KeyRoundIcon />
            <Alert.Title>Model access is off</Alert.Title>
            <Alert.Description>
              This deployment can't store model keys. Set <code>RYPH_SECRETS_KEY</code> on the host
              and restart Ryph to turn it on.
            </Alert.Description>
          </Alert.Root>
        {:else}
          {#if done.model}
            <section class="flex flex-col gap-3">
              <h2 class="text-sm font-semibold">Connected</h2>
              <ul class="divide-y rounded-lg border">
                {#each liveKeys as key (key.id)}
                  <li class="flex items-center gap-3 px-3 py-2.5">
                    <ProviderMark
                      provider={key.provider}
                      label={providerName(key.provider)}
                      class="size-8 rounded-md [&_span]:text-sm [&_svg]:size-4"
                    />
                    <span class="flex min-w-0 flex-col">
                      <span class="truncate text-sm font-medium">{key.label}</span>
                      <span class="text-muted-foreground truncate text-xs">{keyLine(key)}</span>
                    </span>
                  </li>
                {/each}
              </ul>
              {#if !addingKey}
                {@render addAnother("Add another key", () => (addingKey = true))}
              {/if}
            </section>
          {/if}

          {#if showKeyForm}
            <section class="flex flex-col gap-4">
              {#if done.model}
                <h2 class="text-sm font-semibold">Add another key</h2>
              {/if}
              <PickGrid
                items={modelChoices}
                key={(choice) => choice.id}
                text={(choice) => choice.title}
                value={modelChoice}
                onValueChange={chooseModel}
                label="How to connect"
                searchLabel="Search providers"
                card={modelCard}
              />

              {#if modelChoice === PLAN}
                <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
                  <p class="text-muted-foreground max-w-md text-sm">
                    Runs use your ChatGPT plan's usage. Ryph can't see your chats.
                  </p>
                  <Button type="button" variant="outline" onclick={openSignIn}>
                    Continue with ChatGPT
                  </Button>
                </div>
              {:else if chosenProvider}
                <Field.FieldGroup>
                  <KeySecretFields
                    bind:label={keyLabel}
                    bind:secret={keySecret}
                    secretPlaceholder={secretPlaceholder(chosenProvider)}
                    idPrefix="welcome-key"
                  />
                </Field.FieldGroup>
              {:else if modelChoice === CUSTOM}
                <EndpointFields bind:form={endpointForm} />
                <Field.FieldGroup>
                  <Field.Field>
                    <Field.FieldLabel for="welcome-endpoint-secret">API key</Field.FieldLabel>
                    <Input
                      id="welcome-endpoint-secret"
                      type="password"
                      bind:value={keySecret}
                      placeholder="Paste the key"
                      autocomplete="off"
                    />
                    <Field.FieldDescription>
                      The key this endpoint expects. You won't be able to see it again.
                    </Field.FieldDescription>
                  </Field.Field>
                </Field.FieldGroup>
              {/if}
            </section>
          {/if}
        {/if}
      </div>

      <!-- Agent -->
      <div hidden={shown !== "agent"} class="flex max-w-2xl flex-col gap-8">
        {#if data.unread.agents}
          {@render unreadAlert("agents")}
        {/if}
        {#if done.agent}
          <section class="flex flex-col gap-3">
            <h2 class="text-sm font-semibold">Your first task runs with</h2>
            <PickGrid
              items={data.agents}
              key={(agent) => agent.id}
              text={(agent) => `${agent.name} ${agent.handle ?? ""}`}
              value={agentId}
              onValueChange={(id) => (agentId = id)}
              label="Agent"
              searchLabel="Search agents"
              card={agentCard}
            />
            {#if !addingAgent}
              {@render addAnother("Create another agent", () => (addingAgent = true))}
            {/if}
          </section>
        {/if}

        {#if showAgentForm}
          {#if agentKeys.length === 0}
            <Alert.Root>
              <CircleAlertIcon />
              <Alert.Title>Connect a model first</Alert.Title>
              <Alert.Description>
                <span>
                  An agent needs a model to work with.
                  <button
                    type="button"
                    class="text-foreground cursor-pointer underline underline-offset-4"
                    onclick={() => go("model")}
                  >
                    Connect a model
                  </button>
                </span>
              </Alert.Description>
            </Alert.Root>
          {:else}
            <section class="flex flex-col gap-4">
              {#if done.agent}
                <h2 class="text-sm font-semibold">New agent</h2>
              {/if}
              <Field.FieldGroup>
                <Field.Field>
                  <Field.FieldLabel for="welcome-agent-name">Name</Field.FieldLabel>
                  <Input id="welcome-agent-name" bind:value={agentName} placeholder="Ada" />
                  <Field.FieldDescription>
                    Shown as the author of the agent's commits.
                  </Field.FieldDescription>
                </Field.Field>
                <Field.Field>
                  <Field.FieldLabel for="welcome-agent-key">Model key</Field.FieldLabel>
                  <Select.Root type="single" value={agentKey?.id ?? ""} onValueChange={chooseAgentKey}>
                    <Select.Trigger id="welcome-agent-key" class="w-full">
                      {agentKey ? agentKey.label : "Pick a key"}
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Group>
                        {#each agentKeys as key (key.id)}
                          <Select.Item value={key.id} label={`${key.label} (${keyLine(key)})`} />
                        {/each}
                      </Select.Group>
                    </Select.Content>
                  </Select.Root>
                </Field.Field>
                <Field.Field>
                  <Field.FieldLabel for="welcome-agent-model">Model</Field.FieldLabel>
                  <ModelSelect
                    id="welcome-agent-model"
                    bind:value={
                      () => agentModel, (model) => (modelPick = { keyId: agentKey?.id ?? "", model })
                    }
                    models={agentModels}
                    emptyLabel="Default model"
                  />
                  <Field.FieldDescription>Used when a task doesn't pick one.</Field.FieldDescription>
                </Field.Field>
              </Field.FieldGroup>
            </section>
          {/if}
          <p class="text-muted-foreground text-sm">
            Want to set its instructions, tools or limits now?
            <a
              href={withBackTo("/agents/create", returnHere("agent"))}
              class="text-foreground underline underline-offset-4"
            >
              Use the full agent setup</a
            >.
          </p>
        {/if}
      </div>

      <!-- Background model -->
      <div hidden={shown !== "background"} class="flex max-w-2xl flex-col gap-6">
        <Alert.Root>
          <SproutIcon />
          <Alert.Title>Memory works better with a background model</Alert.Title>
          <Alert.Description>
            It extracts useful knowledge and consolidates memories so agents can build on past
            work. Other small tasks, such as dynamic task titles, may use it too. This is separate
            from your agent's model. A fast, inexpensive model is a good fit.
          </Alert.Description>
        </Alert.Root>
        <p class="text-muted-foreground text-sm">
          Background-model usage is tracked and visible on the Usage page. Costs for supported
          models are tracked there too.
        </p>
        {#if data.unread.background}
          {@render unreadAlert("background model settings")}
        {:else if !data.modelAccessEnabled}
          <p class="text-muted-foreground text-sm">
            Model access is off. Set RYPH_SECRETS_KEY on the host and restart Ryph to configure a
            background model.
          </p>
        {:else if backgroundKeys.length === 0}
          <Alert.Root>
            <KeyRoundIcon />
            <Alert.Title>Connect a key for background work</Alert.Title>
            <Alert.Description>
              <span>
                Connect a supported provider's key, an OpenAI-compatible endpoint, or a ChatGPT
                plan with available models. If your plan needs signing in again, reconnect it first.
              </span>
              <Button type="button" variant="outline" class="self-start" onclick={() => go("model")}>
                Connect a model key
              </Button>
            </Alert.Description>
          </Alert.Root>
        {:else}
          <Field.FieldGroup>
            <Field.Field>
              <Field.FieldLabel for="welcome-background-key">Provider key</Field.FieldLabel>
              <Select.Root type="single" value={backgroundKey?.id ?? ""} onValueChange={(id) => (backgroundKeyId = id)}>
                <Select.Trigger id="welcome-background-key" class="w-full">
                  {backgroundKey ? `${backgroundKey.label} (${keyLine(backgroundKey)})` : "Pick a key"}
                </Select.Trigger>
                <Select.Content>
                  <Select.Group>
                    {#each backgroundKeys as key (key.id)}
                      <Select.Item value={key.id} label={`${key.label} (${keyLine(key)})`} />
                    {/each}
                  </Select.Group>
                </Select.Content>
              </Select.Root>
              <Field.FieldDescription>
                Reuse a key you already connected. Background calls use its API billing or plan allowance.
              </Field.FieldDescription>
            </Field.Field>
            <Field.Field>
              <Field.FieldLabel for="welcome-background-model">Model</Field.FieldLabel>
              <ModelSelect
                id="welcome-background-model"
                bind:value={
                  () => backgroundModel,
                  (model) => (backgroundPick = { keyId: backgroundKey?.id ?? "", model })
                }
                models={backgroundModels}
                allowCustom={backgroundKey?.provider !== "chatgpt-plan"}
                required
              />
              <Field.FieldDescription>
                Pick a model for background work. API endpoints also accept a custom model ID.
              </Field.FieldDescription>
            </Field.Field>
          </Field.FieldGroup>
        {/if}
        <p class="text-muted-foreground text-sm">
          You can skip this for now. Without a background model, Memory's model-assisted extraction
          and consolidation won't run. Set it up later in Instance → Platform → Background model.
        </p>
      </div>

      <!-- Repository -->
      <div hidden={shown !== "repo"} class="flex max-w-2xl flex-col gap-8">
        {#if data.unread.repos}
          {@render unreadAlert("repositories")}
        {/if}
        {#if done.repo}
          <section class="flex flex-col gap-3">
            <h2 class="text-sm font-semibold">Your first task works on</h2>
            <PickGrid
              items={data.connectedRepos}
              key={(repo) => repo.id}
              text={(repo) => `${repoTitle(repo)} ${repo.repoRef}`}
              value={repoId}
              onValueChange={(id) => (repoId = id)}
              label="Repository"
              searchLabel="Search repositories"
              card={repoCard}
            />
            {#if !addingRepo}
              {@render addAnother("Add another repository", () => (addingRepo = true))}
            {/if}
          </section>
        {/if}

        {#if showRepoForm}
          {#if localOffered}
            <section class="flex flex-col gap-4">
              {#if done.repo}
                <h2 class="text-sm font-semibold">Add another repository</h2>
              {/if}
              <Field.FieldGroup>
                <Field.Field data-invalid={localProblem !== null || undefined}>
                  <Field.FieldLabel for="welcome-local-path">
                    A repository on this machine
                  </Field.FieldLabel>
                  <Input
                    id="welcome-local-path"
                    bind:value={localPath}
                    placeholder="/home/you/code/my-app"
                    spellcheck={false}
                    autocapitalize="off"
                    autocomplete="off"
                    class="font-mono"
                    disabled={addingLocal}
                    aria-invalid={localProblem !== null}
                  />
                  {#if localProblem}
                    <Field.FieldError>{localProblem}</Field.FieldError>
                  {:else}
                    <Field.FieldDescription>
                      The repository's folder, with its full path. Agents start from its main
                      branch and see only what is committed. Approved changes show up as new
                      branches in it.
                    </Field.FieldDescription>
                  {/if}
                </Field.Field>
              </Field.FieldGroup>
            </section>
          {/if}

          {#if otherWays.length > 0}
            <section class="flex flex-col gap-3">
              {#if localOffered}
                <h2 class="text-sm font-semibold">Or connect one from a forge</h2>
              {/if}
              <div class="flex flex-col divide-y overflow-hidden rounded-lg border">
                {#each otherWays as way (way.id)}
                  <a
                    href={way.href}
                    class="hover:bg-muted/50 flex items-center gap-3 px-3 py-3 text-sm transition-colors"
                  >
                    {#if way.id === "radicle"}
                      <SproutIcon class="text-muted-foreground size-4 shrink-0" />
                    {:else if way.id === "gitlab"}
                      <ForgeIcon provider="gitlab" class="text-muted-foreground" />
                    {:else}
                      <FolderGit2Icon class="text-muted-foreground size-4 shrink-0" />
                    {/if}
                    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span class="font-medium">{way.title}</span>
                      <span class="text-muted-foreground">{way.meta}</span>
                    </span>
                    <ChevronRightIcon class="text-muted-foreground size-4 shrink-0" />
                  </a>
                {/each}
              </div>
            </section>
          {:else if !localOffered}
            <Alert.Root>
              <FolderGit2Icon />
              <Alert.Title>Connect a repository</Alert.Title>
              <Alert.Description>
                <span>
                  <a
                    href={withBackTo("/repos/connect", repoBack)}
                    class="text-foreground underline underline-offset-4"
                  >
                    Choose where your code is hosted</a
                  >.
                </span>
              </Alert.Description>
            </Alert.Root>
          {/if}
        {/if}
      </div>

      <!-- Ready -->
      <div hidden={shown !== "ready"} class="flex max-w-2xl flex-col gap-8">
        <div class="flex items-center gap-5">
          <RyphBlob mood={downloading ? "excited" : "idle"} class="size-20 shrink-0" />
          <dl class="flex min-w-0 flex-col gap-1.5 text-sm">
            <div class="flex gap-2">
              <dt class="text-muted-foreground w-24 shrink-0">Model</dt>
              <dd class="truncate">
                {readyKey?.label ?? "Not connected"}
              </dd>
            </div>
            <div class="flex gap-2">
              <dt class="text-muted-foreground w-24 shrink-0">Background</dt>
              <dd class="truncate">{data.platformPolicy?.model ?? "Not configured"}</dd>
            </div>
            <div class="flex gap-2">
              <dt class="text-muted-foreground w-24 shrink-0">Agent</dt>
              <dd class="truncate">{selectedAgent?.name ?? "Not created"}</dd>
            </div>
            <div class="flex gap-2">
              <dt class="text-muted-foreground w-24 shrink-0">Repository</dt>
              <dd class="truncate">{selectedRepo ? repoTitle(selectedRepo) : "None yet"}</dd>
            </div>
          </dl>
        </div>

        <p class="text-sm">
          {#if selectedAgent}
            Describe what you want done, and {selectedAgent.name} works on it in a sandbox of its
            own. You'll see its progress as it goes.
          {:else}
            Create an agent from the Agents page whenever you're ready.
          {/if}
        </p>

        <ImageDownloads active={shown === "ready"} bind:busy={downloading} />
      </div>
    {/snippet}

    {#snippet footer()}
      {#if current === "ready"}
        <span></span>
      {:else}
        <Button type="button" variant="ghost" onclick={skipSetup}>Skip setup</Button>
      {/if}
      <div class="flex items-center gap-2">
        <Button variant="outline" type="button" disabled={index === 0} onclick={back}>
          <ArrowLeftIcon data-icon="inline-start" />
          Back
        </Button>
        {#if current === "ready"}
          <Button type="submit">
            <PlayIcon data-icon="inline-start" />
            {selectedAgent ? "Start your first task" : "Go to Ryph"}
          </Button>
        {:else if action}
          <Button type="button" variant="ghost" onclick={next}>{stepDone ? "Next" : "Skip"}</Button>
          <Button type="submit" disabled={action.busy}>
            {#if action.busy}
              <Spinner data-icon="inline-start" />
            {:else}
              <PlusIcon data-icon="inline-start" />
            {/if}
            {action.label}
          </Button>
        {:else}
          <Button type="submit" variant={stepDone ? "default" : "outline"}>
            {stepDone ? "Next" : "Skip"}
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        {/if}
      </div>
    {/snippet}
  </SteppedFlow>
</form>

{#key signInSession}
  <ChatgptSignInDialog bind:open={signInOpen} onDone={signedIn} />
{/key}
