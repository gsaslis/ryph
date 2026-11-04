<script lang="ts">
import { untrack } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { createTask } from "$lib/api/tasks";
import type { Agent, ConnectedRepo, ThinkingLevel, WorkspaceWithRepos } from "$lib/api/types";
import { can } from "$lib/utils/auth/capabilities";
import AgentAvatar from "$lib/components/agent-avatar/agent-avatar.svelte";
import ForgeIcon from "$lib/components/forge-icon/forge-icon.svelte";
import PickCard from "$lib/components/pick-card/pick-card.svelte";
import PickGrid from "$lib/components/pick-card/pick-grid.svelte";
import { preselect } from "$lib/components/pick-card/pick-list";
import TaskColumn from "$lib/components/task-page/task-column.svelte";
import { Button } from "$lib/components/ui/button";
import * as Collapsible from "$lib/components/ui/collapsible";
import * as Empty from "$lib/components/ui/empty";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import ModelSelect from "$lib/components/model-picker/model-select.svelte";
import {
  choicesFor,
  modelsForKey,
  thinkingLevelsForKey,
} from "$lib/components/model-picker/models";
import ThinkingSelect from "$lib/components/model-picker/thinking-select.svelte";
import {
  offersThinking,
  THINKING_LABELS,
  thinkingInvalid,
  thinkingToSend,
} from "$lib/components/model-picker/thinking";
import { Spinner } from "$lib/components/ui/spinner";
import * as ToggleGroup from "$lib/components/ui/toggle-group";
import { agentAvatar } from "$lib/utils/avatar";
import { forgeRepoLabel, localRepoName, shortenRid } from "$lib/utils/forge";
import { HOUR_MS } from "$lib/utils/limits";
import BotIcon from "@lucide/svelte/icons/bot";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import LayersIcon from "@lucide/svelte/icons/layers";
import PlayIcon from "@lucide/svelte/icons/play";
import PlusIcon from "@lucide/svelte/icons/plus";
import {
  BLANK_TASK_LIMITS,
  composeTaskLimits,
  effectiveLimits,
  taskLimitsProblem,
} from "./task-limits";
import { readLastPicks, rememberLastPicks } from "./last-picks";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

type Source = "repo" | "workspace";

// The starting picks are only where the page opens: what the link asked for (`?agent=`, `?repo=`,
// as the welcome flow links here), else, once in the browser, what was started with last time,
// else the only agent or repo there is. From there the person picks. A link followed while the
// page is open picks again.
const askedAgentId = $derived(page.url.searchParams.get("agent"));
const askedRepoId = $derived(page.url.searchParams.get("repo"));
/** The asked id where the list has it, else the remembered one, else the only one there is. */
const startingPick = (ids: readonly string[], ask: string | null, remembered: string | null) =>
  preselect(ids, ask !== null && ids.includes(ask) ? ask : remembered);
// svelte-ignore state_referenced_locally
let agentId = $state(startingPick(data.agents.map((a) => a.id), askedAgentId, null));
// What the task checks out: a connected repo, or a workspace (its saved list).
let source = $state<Source>("repo");
// svelte-ignore state_referenced_locally
let connectedRepoId = $state(
  startingPick(data.connectedRepos.map((r) => r.id), askedRepoId, null),
);
// svelte-ignore state_referenced_locally
let workspaceId = $state(preselect(data.workspaces.map((w) => w.workspace.id), null));
// "" = the connected repo's default branch.
let ref = $state("");
// "" = the agent's default (the policy default, else the harness's own).
let model = $state("");
// null = the agent's default (the policy default, else the harness's own).
let thinking = $state<ThinkingLevel | null>(null);
// Each blank = the agent's own limit.
let limitFields = $state({ ...BLANK_TASK_LIMITS });
// The base ref, the model and the limits: tuning knobs, folded until wanted.
let optionsOpen = $state(false);
/** Start was pressed, so what is still missing is said under it. */
let attempted = $state(false);
let starting = $state(false);

// Once in the browser, and again whenever the link asks for something else. Only the address
// is followed here: the lists reloading leave what the person picked alone.
$effect(() => {
  const ask = { agentId: askedAgentId, connectedRepoId: askedRepoId };
  untrack(() => {
    const last = readLastPicks();
    agentId = startingPick(data.agents.map((a) => a.id), ask.agentId, last.agentId);
    const repoIds = data.connectedRepos.map((r) => r.id);
    connectedRepoId = startingPick(repoIds, ask.connectedRepoId, last.connectedRepoId);
    workspaceId = preselect(data.workspaces.map((w) => w.workspace.id), last.workspaceId);
    // A repo the link asked for is the source, whatever was started with last time.
    const repoAsked = ask.connectedRepoId !== null && repoIds.includes(ask.connectedRepoId);
    source = !repoAsked && last.source === "workspace" && workspaceId !== "" ? "workspace" : "repo";
  });
});

// A Radicle repo's name, as the node answers for it, so the card can say it and a search find it.
let radicleNames = $state<Record<string, string>>({});
$effect(() => {
  let current = true;
  for (const [id, name] of Object.entries(data.radicleNames)) {
    name.then((resolved) => {
      if (current && resolved !== null) radicleNames[id] = resolved;
    });
  }
  return () => {
    current = false;
  };
});

const selectedAgent = $derived(data.agents.find((agent) => agent.id === agentId));
const modelPolicy = $derived(selectedAgent?.modelPolicy ?? null);
// The agent's own key: a ChatGPT plan's provider entry lists every plan key's models at once,
// and the task runs on this one account's. A key the list does not have (model access off)
// falls back to the policy's provider entry for both.
const agentKey = $derived(data.providerKeys.find((key) => key.id === modelPolicy?.providerKeyId));
const modelChoices = $derived(
  modelPolicy === null ? [] : choicesFor(
    modelsForKey(data.providers, agentKey, modelPolicy.provider),
    modelPolicy.allowedModels,
  ),
);
// The levels the model this task runs on takes: the pick, else the agent's default model.
const thinkingLevels = $derived(
  thinkingLevelsForKey(
    data.providers,
    agentKey,
    model.trim() || (modelPolicy?.defaultModel ?? ""),
    modelPolicy?.provider,
  ),
);
const sentThinking = $derived(thinkingToSend(thinking, thinkingLevels));
const selectedRepo = $derived(data.connectedRepos.find((repo) => repo.id === connectedRepoId));
const selectedWorkspace = $derived(data.workspaces.find((w) => w.workspace.id === workspaceId));
const repoNameById = $derived(
  new Map(data.connectedRepos.map((r) => [r.id, forgeRepoLabel(r)])),
);
const isAdmin = $derived(can(data.user, "agents:policy"));
const effective = $derived(effectiveLimits(data.limits, selectedAgent?.limitPolicy ?? null));
const limitProblem = $derived(taskLimitsProblem(limitFields, effective, isAdmin, data.limits));
/** A limit's default, as the field's placeholder. */
const placeholderOf = (value: number | null, unit = 1) =>
  value === null ? "No cap" : String(value / unit);

/** What stops the settings from starting a task, in the words to say it with. */
const problem = $derived.by(() => {
  if (!agentId) return "Pick an agent to run this task";
  if (source === "repo" && !connectedRepoId) return "Pick a repository for the agent to work on";
  if (source === "workspace" && !workspaceId) return "Pick a workspace for the agent to work on";
  return limitProblem;
});

const hasOptions = $derived(source === "repo" || selectedAgent !== undefined);

// The model pick belongs to one agent's allowlist, and the limits to its policy: picking another
// agent resets both.
function pickAgent(id: string) {
  if (id === agentId) return;
  agentId = id;
  model = "";
  thinking = null;
  limitFields = { ...BLANK_TASK_LIMITS };
}

function pickSource(value: string) {
  // A single toggle group lets its pressed item be pressed off; that is not a choice here.
  if (value === "repo" || value === "workspace") source = value;
}

/** A repo by what a person calls it: the name, without the owner or the folder it is in. */
function repoTitle(repo: ConnectedRepo): string {
  if (repo.provider === "radicle") return radicleNames[repo.id] ?? shortenRid(repo.repoRef);
  if (repo.provider === "local") return localRepoName(repo.repoRef);
  return repo.repoRef.split("/").at(-1) ?? repo.repoRef;
}

/** Then the rest of its address, on the line under. */
function repoMeta(repo: ConnectedRepo): string {
  return repo.provider === "radicle" ? shortenRid(repo.repoRef) : repo.repoRef;
}

function workspaceMembers(ws: WorkspaceWithRepos): string {
  return ws.repos.map((r) => r.path).join(", ");
}

async function submit(event: SubmitEvent) {
  event.preventDefault();
  attempted = true;
  if (problem !== null) {
    if (problem === limitProblem) optionsOpen = true;
    return;
  }
  const limits = composeTaskLimits(limitFields);

  starting = true;
  try {
    // No instructions: the task opens on its own page, which asks for them while its sandbox
    // gets ready.
    const created = await createTask(fetch, {
      agentId,
      spec: {},
      ...(source === "workspace"
        ? { workspaceId }
        : { connectedRepoId, ...(ref.trim() ? { ref: ref.trim() } : {}) }),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(modelPolicy !== null && sentThinking !== null ? { thinking: sentThinking } : {}),
      ...(Object.keys(limits).length > 0 ? { limits } : {}),
    });
    rememberLastPicks({
      agentId,
      source,
      connectedRepoId: connectedRepoId || null,
      workspaceId: workspaceId || null,
    });
    await goto(`/tasks/${created.taskId}`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to start the task");
  } finally {
    starting = false;
  }
}
</script>

<svelte:head>
  <title>New task · Ryph</title>
</svelte:head>

<!-- A new task is set up here, then opens on its own page, which asks what it is for. -->
<TaskColumn>
  <section class="flex flex-1 flex-col items-center justify-center py-6 md:py-10">
    <form onsubmit={submit} class="flex w-full max-w-2xl flex-col gap-8" novalidate>
      <!-- The face the next page asks with, in the same place: it turns into the agent's as one
           is picked. -->
      <header class="flex flex-col items-center gap-4 text-center">
        {#if selectedAgent}
          <AgentAvatar agentId={selectedAgent.id} size="lg" class="size-12" />
        {:else}
          <span class="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
            <BotIcon class="size-6" />
          </span>
        {/if}
        <div class="flex flex-col gap-1.5">
          <h1 class="font-heading text-xl leading-snug font-bold tracking-[-0.02em] text-balance md:text-2xl">
            {selectedAgent ? `Start a task with ${selectedAgent.name}` : "Start a task"}
          </h1>
          <p class="text-muted-foreground text-sm text-balance">
            Pick who works on it and where. You'll say what to do next.
          </p>
        </div>
      </header>

      <section aria-labelledby="pick-agent" class="flex flex-col gap-3">
        <h2 id="pick-agent" class="px-1 text-sm font-medium">Agent</h2>
        {#if data.agents.length === 0}
          <Empty.Root class="gap-3 border border-dashed p-6 md:p-8">
            <Empty.Header>
              <Empty.Title>No agents yet</Empty.Title>
              <Empty.Description>A task needs an agent to work on it.</Empty.Description>
            </Empty.Header>
            <Empty.Content>
              <Button size="sm" href="/agents/create">
                <PlusIcon data-icon="inline-start" />
                New agent
              </Button>
            </Empty.Content>
          </Empty.Root>
        {:else}
          <PickGrid
            items={data.agents}
            key={(agent) => agent.id}
            text={(agent) => `${agent.name} ${agent.handle ?? ""}`}
            value={agentId}
            onValueChange={pickAgent}
            label="Agent"
            searchLabel="Search agents"
            card={agentCard}
          />
        {/if}
      </section>

      <section aria-labelledby="pick-source" class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1">
          <h2 id="pick-source" class="text-sm font-medium">Works on</h2>
          <ToggleGroup.Root
            type="single"
            variant="outline"
            size="sm"
            value={source}
            onValueChange={pickSource}
            aria-label="What the agent works on"
          >
            <ToggleGroup.Item value="repo">Repository</ToggleGroup.Item>
            <ToggleGroup.Item value="workspace" disabled={data.workspaces.length === 0}>
              Workspace
            </ToggleGroup.Item>
          </ToggleGroup.Root>
        </div>

        {#if source === "repo"}
          {#if data.connectedRepos.length === 0}
            <Empty.Root class="gap-3 border border-dashed p-6 md:p-8">
              <Empty.Header>
                <Empty.Title>No repositories connected</Empty.Title>
                <Empty.Description>Connect one for the agent to work on.</Empty.Description>
              </Empty.Header>
              <Empty.Content>
                <Button size="sm" href="/repos/connect">
                  <PlusIcon data-icon="inline-start" />
                  Connect repository
                </Button>
              </Empty.Content>
            </Empty.Root>
          {:else}
            <PickGrid
              items={data.connectedRepos}
              key={(repo) => repo.id}
              text={(repo) => `${repoTitle(repo)} ${repo.repoRef}`}
              value={connectedRepoId}
              onValueChange={(id) => (connectedRepoId = id)}
              label="Repository"
              searchLabel="Search repositories"
              card={repoCard}
            />
            <p class="text-muted-foreground px-1 text-xs">The finished work comes back as a patch.</p>
          {/if}
        {:else if source === "workspace"}
          <PickGrid
            items={data.workspaces}
            key={(ws) => ws.workspace.id}
            text={(ws) => `${ws.workspace.name} ${workspaceMembers(ws)}`}
            value={workspaceId}
            onValueChange={(id) => (workspaceId = id)}
            label="Workspace"
            searchLabel="Search workspaces"
            card={workspaceCard}
          />
          <p class="text-muted-foreground px-1 text-xs">
            {#if selectedWorkspace}
              Checks out {selectedWorkspace.repos.map((r) =>
                `${repoNameById.get(r.connectedRepoId) ?? r.connectedRepoId} (${r.path}/)`
              ).join(", ")}, each at its saved ref. A change to each repo becomes its own patch.
            {:else}
              Every repository in the workspace, side by side, at their saved refs.
            {/if}
          </p>
        {/if}
      </section>

      {#if hasOptions}
        <Collapsible.Root bind:open={optionsOpen} class="group/options flex flex-col gap-4">
          <Collapsible.Trigger
            class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-fit cursor-pointer items-center gap-1 rounded-md px-1 text-sm transition-colors outline-none focus-visible:ring-[3px] motion-reduce:transition-none"
          >
            <ChevronRightIcon
              class="size-4 transition-transform group-data-[state=open]/options:rotate-90 motion-reduce:transition-none"
            />
            Options
          </Collapsible.Trigger>
          <Collapsible.Content>
            <Field.FieldGroup class="@container gap-5 px-1">
              {#if source === "repo" || modelPolicy}
                <div class="grid gap-5 @md:grid-cols-2">
                  {#if source === "repo"}
                    <Field.Field>
                      <Field.FieldLabel for="base-ref">Base ref</Field.FieldLabel>
                      <Input
                        id="base-ref"
                        bind:value={ref}
                        placeholder={selectedRepo?.defaultBranch ?? "Default branch"}
                        autocomplete="off"
                        spellcheck={false}
                      />
                      <Field.FieldDescription>
                        The branch to start from. Empty is the repo's default.
                      </Field.FieldDescription>
                    </Field.Field>
                  {/if}
                  {#if modelPolicy}
                    <Field.Field>
                      <Field.FieldLabel for="model">Model</Field.FieldLabel>
                      <!-- Keyed on the agent, so a half-made custom pick does not outlive the
                           switch. -->
                      {#key agentId}
                        <ModelSelect
                          id="model"
                          bind:value={model}
                          models={modelChoices}
                          emptyLabel={modelPolicy.defaultModel
                            ? `Agent default (${modelPolicy.defaultModel})`
                            : "Agent default"}
                          allowCustom={modelPolicy.allowedModels === "*"}
                        />
                      {/key}
                      <Field.FieldDescription>
                        {modelPolicy.allowedModels === "*"
                          ? "Any model the agent's provider serves."
                          : "Limited to the agent's allowed models."}
                      </Field.FieldDescription>
                    </Field.Field>
                  {/if}
                  {#if modelPolicy && offersThinking(thinkingLevels)}
                    <Field.Field data-invalid={thinkingInvalid(thinking, thinkingLevels) || undefined}>
                      <Field.FieldLabel for="thinking">Thinking level</Field.FieldLabel>
                      <ThinkingSelect
                        id="thinking"
                        bind:value={thinking}
                        levels={thinkingLevels}
                        emptyLabel={modelPolicy.defaultThinking
                          ? `Agent default (${THINKING_LABELS[modelPolicy.defaultThinking]})`
                          : "Agent default"}
                      />
                    </Field.Field>
                  {/if}
                </div>
              {/if}
              {#if selectedAgent}
                <Field.FieldSet class="gap-3">
                  <Field.FieldLegend variant="label" class="mb-0">Limits</Field.FieldLegend>
                  <div class="grid gap-3 @md:grid-cols-3">
                    <Field.Field>
                      <Field.FieldLabel for="limit-hours" class="text-muted-foreground font-normal">
                        Wall clock (hours)
                      </Field.FieldLabel>
                      <Input
                        id="limit-hours"
                        type="number"
                        min="0.02"
                        step="0.25"
                        placeholder={placeholderOf(effective.wallClockMs, HOUR_MS)}
                        bind:value={limitFields.wallClockHours}
                      />
                    </Field.Field>
                    <Field.Field>
                      <Field.FieldLabel for="limit-spend" class="text-muted-foreground font-normal">
                        Spend (USD)
                      </Field.FieldLabel>
                      <Input
                        id="limit-spend"
                        type="number"
                        min="0.01"
                        step="0.01"
                        placeholder={placeholderOf(effective.spendUsd)}
                        bind:value={limitFields.spendUsd}
                      />
                    </Field.Field>
                    <Field.Field>
                      <Field.FieldLabel for="limit-calls" class="text-muted-foreground font-normal">
                        Calls in flight
                      </Field.FieldLabel>
                      <Input
                        id="limit-calls"
                        type="number"
                        min="1"
                        step="1"
                        placeholder={placeholderOf(effective.callsInFlight)}
                        bind:value={limitFields.callsInFlight}
                      />
                    </Field.Field>
                  </div>
                  <Field.FieldDescription>
                    Empty is the agent's own. Anyone may lower a limit for this task;
                    {isAdmin
                      ? "as an administrator you may raise one up to the deployment's ceiling."
                      : "raising one needs an administrator."}
                  </Field.FieldDescription>
                </Field.FieldSet>
              {/if}
            </Field.FieldGroup>
          </Collapsible.Content>
        </Collapsible.Root>
      {/if}

      <div class="flex flex-col items-center gap-2">
        <Button type="submit" size="lg" class="min-w-40" disabled={starting}>
          {#if starting}
            <Spinner data-icon="inline-start" />
          {:else}
            <PlayIcon data-icon="inline-start" />
          {/if}
          Start
        </Button>
        <p class="text-destructive min-h-4 text-center text-xs" aria-live="polite">
          {attempted && problem !== null ? problem : ""}
        </p>
      </div>
    </form>
  </section>
</TaskColumn>

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
      <span class={repo.provider !== "github" ? "font-mono" : undefined}>{repoMeta(repo)}</span>
    {/snippet}
  </PickCard>
{/snippet}

{#snippet workspaceCard(ws: WorkspaceWithRepos)}
  <PickCard value={ws.workspace.id}>
    {#snippet media()}
      <span class="bg-background ring-border flex size-8 items-center justify-center rounded-md ring-1">
        <LayersIcon class="size-4" />
      </span>
    {/snippet}
    {#snippet title()}
      {ws.workspace.name}
    {/snippet}
    {#snippet meta()}
      {ws.repos.length === 1 ? "1 repository" : `${ws.repos.length} repositories`}:
      {workspaceMembers(ws)}
    {/snippet}
  </PickCard>
{/snippet}
