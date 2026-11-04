<script lang="ts">
import { goto } from "$app/navigation";
import { getAgents } from "$lib/api/agents";
import {
  type EnvironmentDefinitionRead,
  type EnvironmentSubject,
  getEnvironment,
  rebuildEnvironment,
  setupEnvironment,
} from "$lib/api/environments";
import type { Agent, SubjectEnvironment } from "$lib/api/types";
import * as Dialog from "$lib/components/ui/dialog";
import * as Field from "$lib/components/ui/field";
import * as Select from "$lib/components/ui/select";
import Markdown from "$lib/components/markdown/markdown.svelte";
import SetupWarnings from "./setup-warnings.svelte";
import * as Alert from "$lib/components/ui/alert";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Spinner } from "$lib/components/ui/spinner";
import { Skeleton } from "$lib/components/ui/skeleton";
import {
  buildKindLabel,
  buildProgress,
  builtAt,
  environmentHeadline,
  environmentStatusLabel,
  latestBuild,
  setupAction,
  toolchainEntries,
} from "$lib/utils/environments";
import { formatDateTime, formatRelativeTime } from "$lib/utils/format";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import HammerIcon from "@lucide/svelte/icons/hammer";
import SparklesIcon from "@lucide/svelte/icons/sparkles";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import { type Snippet, untrack } from "svelte";
import { toast } from "svelte-sonner";

let {
  subject,
  environment,
  definition,
  canManage,
  children,
}: {
  subject: EnvironmentSubject;
  /** What the page's load read, or why it could not. */
  environment: SubjectEnvironment | { error: string };
  /**
   * The forge half, which the page's load STREAMS: it asks the forge, which fetches the
   * repository from upstream, and the card must not wait for that. Until it lands the card
   * renders every fact it has and says it is still reading the rest.
   */
  definition: Promise<EnvironmentDefinitionRead>;
  /** Whether the user holds resources:manage, which a rebuild takes: it spends compute. */
  canManage: boolean;
  /** Rows only one kind of subject has (a workspace's environment repo), under the facts. */
  children?: Snippet;
} = $props();

// A build in flight is followed from here rather than by re-running the page's whole load: the
// card polls its own route while something is queued or building, and a fresh load (the page
// invalidating after an edit) replaces what it polled.
let polled = $state<SubjectEnvironment | null>(null);
$effect(() => {
  environment;
  untrack(() => (polled = null));
});
const env = $derived(polled ?? ("error" in environment ? null : environment));
const headline = $derived(env === null ? null : environmentHeadline(env));
const shown = $derived(env === null ? null : latestBuild(env));
const building = $derived(headline?.kind === "building");

// Keep the summary's elapsed time and status fresh while a build is running.
let now = $state(Date.now());

$effect(() => {
  if (!building) return;
  const poll = setInterval(async () => {
    now = Date.now();
    try {
      // One database read on the control plane: the forge half is its own route, which the poll
      // never asks — what the default branch describes cannot change mid-build anyway.
      polled = await getEnvironment(fetch, subject);
    } catch {
      // A missed poll is not news; the next one, or a reload, catches up.
    }
  }, 5_000);
  return () => clearInterval(poll);
});

// The streamed half, unwrapped for the template: null until it lands, then the read or its
// failure. Keep the last answer during refresh, but never across subjects.
let read = $state<EnvironmentDefinitionRead>(null);
let readSubject = "";
$effect(() => {
  const asked = definition;
  const key = `${subject.kind}:${subject.id}`;
  let live = true;
  untrack(() => {
    if (readSubject !== key) read = null;
    readSubject = key;
  });
  void asked.then((answer) => {
    if (live && answer !== null) read = answer;
  }, (error: unknown) => {
    if (live) {
      read = { error: error instanceof Error ? error.message : "the repository could not be read" };
    }
  });
  return () => {
    live = false;
  };
});

let rebuilding = $state(false);
async function rebuild() {
  if (env === null) return;
  rebuilding = true;
  try {
    const build = await rebuildEnvironment(fetch, subject);
    polled = { ...env, latest: build };
    toast.success("Rebuilding the environment from the default branch");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to start a rebuild");
  } finally {
    rebuilding = false;
  }
}

const canRebuild = $derived(
  canManage && env !== null && env.enabled && env.refusedReason === null && !building,
);

// ---- "Set up this repo's environment": a task an agent runs, not a form a person fills ----
// The agent list is read when the dialog opens rather than with the page: most visits to a
// settings page never press this.
const setup = $derived(setupAction(env, read, subject.kind));
let setupOpen = $state(false);
let agents = $state<Agent[] | null>(null);
// Agents exist, but none of them may open patches.
let onlyPatchless = $state(false);
let agentsError = $state<string | null>(null);
let agentId = $state("");
let starting = $state(false);
const chosen = $derived(agents?.find((a) => a.id === agentId));

async function openSetup() {
  setupOpen = true;
  if (agents !== null) return;
  try {
    // Setting up ends in a patch of .ryph/, which an agent that may not open patches cannot send.
    const live = (await getAgents(fetch)).filter((a) => !a.archivedAt);
    agents = live.filter((a) => a.canOpenPatches);
    onlyPatchless = live.length > 0 && agents.length === 0;
  } catch (e) {
    agentsError = e instanceof Error ? e.message : "the agents could not be read";
  }
}

async function startSetup(event: SubmitEvent) {
  event.preventDefault();
  if (!agentId) return;
  starting = true;
  try {
    const { taskId } = await setupEnvironment(fetch, subject, { agentId });
    toast.success(`${chosen?.name ?? "The agent"} is setting up the environment`);
    setupOpen = false;
    await goto(`/tasks/${encodeURIComponent(taskId)}`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to start the setup task");
  } finally {
    starting = false;
  }
}
</script>

<div class="flex flex-col gap-4">
  {#if env === null || headline === null}
    <p class="text-muted-foreground text-sm">
      The environment could not be read right now{"error" in environment
        ? `: ${environment.error}`
        : ""}.
    </p>
  {:else if headline.kind === "off"}
    <p class="text-muted-foreground text-sm">
      Environments are off on this deployment, so runs start on the default image, which installs
      whatever toolchain versions a repository pins as it runs.
    </p>
  {:else if headline.kind === "refused"}
    <Alert.Root>
      <TriangleAlertIcon />
      <Alert.Title>Environments cannot be built here</Alert.Title>
      <Alert.Description>
        {headline.reason} Runs start on the default image instead.
      </Alert.Description>
    </Alert.Root>
  {:else if headline.kind === "none"}
    <p class="text-muted-foreground text-sm">
      Nothing built yet, so runs start on the default image. The first build starts when the
      default branch next moves{canManage ? ", or when you rebuild" : ""}.
    </p>
    {#if setup?.state === "reading"}
      <div role="status" aria-label="Reading environment configuration" class="flex flex-col gap-2">
        <Skeleton class="h-4 w-56 max-w-full" />
        <Skeleton class="h-24 w-full" />
      </div>
    {:else if setup?.state === "offer" && setup.prominent}
      <Alert.Root>
        <SparklesIcon />
        <Alert.Title>No <code>.ryph/</code> yet</Alert.Title>
        <Alert.Description class="flex flex-col items-start gap-3">
          <span>
            An agent can write one. It reads the CI config and toolchain pins, writes
            <code>setup.yml</code> and <code>environment.md</code>, a Dockerfile only if needed,
            and iterates on a patch until the build passes.
          </span>
          <Button size="sm" onclick={openSetup}>
            <SparklesIcon data-icon="inline-start" />
            {setup.label}
          </Button>
        </Alert.Description>
      </Alert.Root>
    {/if}
  {:else}
    {@const current = headline.current}
    {@const pending = headline.kind === "ready" ? null : headline.build}
    <!-- Keep the machine summary here; diagnostics and logs live on the build page. -->
    <div class="bg-card rounded-lg border text-sm">
      <div class="flex flex-col gap-3 p-4">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          {#if headline.kind === "building" && pending}
            {@const progress = buildProgress(pending, now)}
            <span class="flex items-center gap-2 font-medium">
              <Spinner class="size-3.5" />
              {environmentStatusLabel(pending.status)}
            </span>
            <Badge variant="outline">{buildKindLabel(pending.kind)}</Badge>
            {#if progress}
              <span class="text-muted-foreground tabular-nums">{progress}</span>
            {/if}
            <span class="text-muted-foreground basis-full">
              {current
                ? "Runs use the previous build until this one is ready."
                : "Runs that need it wait for it; the rest use the default image."}
            </span>
          {:else if headline.kind === "failed" && pending}
            <span class="text-destructive flex items-center gap-2 font-medium">
              <span class="bg-destructive size-2 rounded-full"></span>
              Last build failed
            </span>
            <span class="text-muted-foreground">
              {current
                ? "Runs still use the previous build."
                : pending.machine
                ? "Runs here wait until a build succeeds."
                : "Runs use the default image until a build succeeds."}
            </span>
          {:else if current}
            <span class="flex items-center gap-2 font-medium">
              <span class="bg-success size-2 rounded-full"></span>
              Ready
            </span>
            <span class="text-muted-foreground" title={formatDateTime(builtAt(current))}>
              Built {formatRelativeTime(builtAt(current))} from
              <span class="font-mono text-xs">{current.ref}</span>
            </span>
          {/if}
        </div>
        {#if current}
          {@const tools = toolchainEntries(current.toolchains)}
          {#if tools.length > 0}
            <ul class="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
              {#each tools as [name, version] (name)}
                <li>{name} <span class="text-muted-foreground">{version}</span></li>
              {/each}
            </ul>
          {/if}
        {/if}
        <!-- However the build ended, and that is the point. A build refused a host usually still
             SUCCEEDS — a RUN step swallows the download's exit code — and then ships an image
             missing whatever it was for, which the next person meets as an unrelated run failing
             days later. Never folded away, because the build's own output does not say it: the
             proxy refused the connection, so the log only says something could not be reached. -->
        {#if shown}
          <SetupWarnings warnings={shown.setupWarnings} />
        {/if}
        {#if shown?.egressNote}
          <Alert.Root variant="destructive">
            <TriangleAlertIcon />
            <Alert.Title>The internet allowlist refused this build</Alert.Title>
            <Alert.Description>
              <Markdown content={shown.egressNote} />
            </Alert.Description>
          </Alert.Root>
        {/if}
      </div>

      {#if shown}
        <div class="border-t">
          <a
            href="/builds/{shown.id}"
            class="text-muted-foreground hover:text-foreground flex items-center gap-1.5 px-4 py-2.5 text-xs underline-offset-4 hover:underline"
          >
            View build details
            <ChevronRightIcon class="size-3.5" />
          </a>
        </div>
      {/if}
    </div>
  {/if}

  {@render children?.()}

  {#if env !== null && env.enabled && env.refusedReason === null}
    <div class="flex flex-wrap items-center gap-3">
      {#if setup?.state === "reading"}
        <span class="text-muted-foreground flex items-center gap-2 text-sm">
          <Spinner class="size-3.5" />
          {setup.note}
        </span>
      {:else if setup?.state === "unreadable"}
        <span class="text-muted-foreground text-sm">{setup.note}</span>
      {:else if setup?.state === "offer" && !setup.prominent}
        <Button variant="outline" size="sm" onclick={openSetup}>
          <SparklesIcon data-icon="inline-start" />
          {setup.label}
        </Button>
      {/if}
      {#if canManage}
        <Button variant="outline" size="sm" disabled={!canRebuild || rebuilding} onclick={rebuild}>
          {#if rebuilding}
            <Spinner data-icon="inline-start" />
          {:else}
            <HammerIcon data-icon="inline-start" />
          {/if}
          Rebuild
        </Button>
      {/if}
      <p class="text-muted-foreground basis-full text-xs">
        Builds from the default branch. Changes under <code>.ryph/</code> rebuild right away,
        other pushes at most every few hours.
        {#if !canManage}Rebuilding takes resources:manage.{/if}
      </p>
    </div>
  {/if}
</div>

<Dialog.Root bind:open={setupOpen}>
  <Dialog.Content>
    <form onsubmit={startSetup} class="flex flex-col gap-4">
      <Dialog.Header>
        <Dialog.Title>
          {setup?.state === "offer" ? setup.label : "Set up the environment"}
        </Dialog.Title>
        <Dialog.Description>
          Starts a task for the agent you pick. It writes <code>.ryph/</code> from what the
          {subject.kind === "repo" ? "repository" : "workspace's environment repository"} says it
          needs, ships it as a patch, and keeps revising it until the platform's build of that
          patch succeeds. The patch is reviewed like any other; the task can be cancelled like any
          other.
        </Dialog.Description>
      </Dialog.Header>
      <Field.FieldGroup>
        <Field.Field>
          <Field.FieldLabel for="setup-agent">Agent</Field.FieldLabel>
          <Select.Root type="single" bind:value={agentId}>
            <Select.Trigger id="setup-agent" class="w-full">
              {chosen?.name ?? (agents === null && agentsError === null ? "Loading…" : "Select an agent")}
            </Select.Trigger>
            <Select.Content>
              <Select.Group>
                {#each agents ?? [] as agent (agent.id)}
                  <Select.Item value={agent.id} label={agent.name} />
                {/each}
              </Select.Group>
            </Select.Content>
          </Select.Root>
          {#if agentsError}
            <Field.FieldError>{agentsError}</Field.FieldError>
          {:else if onlyPatchless}
            <Field.FieldDescription>
              None of your agents can open patches, and setting up an environment ends in one.
            </Field.FieldDescription>
          {:else if agents !== null && agents.length === 0}
            <Field.FieldDescription>
              No agents yet — <a href="/agents/create" class="underline underline-offset-4"
                >create one</a
              > first.
            </Field.FieldDescription>
          {:else}
            <Field.FieldDescription>
              It needs a harness that can use tools and skills: it follows the environment skill,
              ships its patch and reads the build's result.
            </Field.FieldDescription>
          {/if}
        </Field.Field>
      </Field.FieldGroup>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => (setupOpen = false)}>Cancel</Button>
        <Button type="submit" disabled={starting || !agentId}>
          {#if starting}
            <Spinner data-icon="inline-start" />
          {/if}
          Start
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
