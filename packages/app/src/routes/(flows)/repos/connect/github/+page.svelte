<script lang="ts">
import { goto, invalidateAll } from "$app/navigation";
import { ApiError } from "$lib/api/call";
import { connectGithubUserRepo } from "$lib/api/repos";
import type { SubmissionPolicy } from "$lib/api/types";
import FlowStep from "$lib/components/flow-step/flow-step.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Field from "$lib/components/ui/field";
import * as InputGroup from "$lib/components/ui/input-group";
import * as Select from "$lib/components/ui/select";
import { Skeleton } from "$lib/components/ui/skeleton";
import { Spinner } from "$lib/components/ui/spinner";
import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
import CheckIcon from "@lucide/svelte/icons/check";
import LinkIcon from "@lucide/svelte/icons/link-2";
import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
import SearchIcon from "@lucide/svelte/icons/search";
import { toast } from "svelte-sonner";
import UnavailableStep from "../unavailable-step.svelte";
import type { PageProps } from "./$types";
import { withBackTo } from "$lib/utils/safe-path";
import { filterGithubRepos, githubConnectFailure, githubListFailure } from "./listing";

let { data }: PageProps = $props();

// Where leaving the flow goes: the page that opened it, else the repositories.
const exitHref = $derived(data.backTo ?? "/repos");
const backHref = $derived(data.multiForge ? withBackTo("/repos/connect", data.backTo) : exitHref);

const policyLabels: Record<SubmissionPolicy, string> = {
  "require-approval": "Require approval",
  auto: "Auto-submit agent submissions",
};

let query = $state("");
let picked = $state<string | null>(null);
let submissionPolicy: SubmissionPolicy = $state("require-approval");
let connecting = $state(false);
let retrying = $state(false);

async function retry() {
  retrying = true;
  try {
    await invalidateAll();
  } finally {
    retrying = false;
  }
}

async function submit(event: SubmitEvent) {
  event.preventDefault();
  if (!data.login) return;
  if (!picked) {
    toast.error("Pick a repository to connect");
    return;
  }
  connecting = true;
  try {
    const repo = await connectGithubUserRepo(fetch, { repoRef: picked, submissionPolicy });
    toast.success(`Connected ${repo.repoRef}`);
    await goto(data.backTo ?? `/repos/${repo.id}`);
  } catch (e) {
    toast.error(githubConnectFailure(e, data.login));
    // Someone else connected it meanwhile: read the list again so it shows as connected.
    if (e instanceof ApiError && e.status === 409) {
      picked = null;
      await invalidateAll();
    }
  } finally {
    connecting = false;
  }
}
</script>

<svelte:head>
  <title>Connect from your GitHub · Ryph</title>
</svelte:head>

{#if data.unavailable || !data.login}
  <UnavailableStep headline="Connect from your GitHub" {exitHref} />
{:else if !data.allowed}
  <FlowStep
  headline="Connect from your GitHub"
  description="Ryph acts as @{data.login} on GitHub for everyone here, so only admins can connect repositories."
>
    {#snippet leftActions()}
      <Button variant="ghost" href={backHref}>
        {data.multiForge ? "Back" : "Cancel"}
      </Button>
    {/snippet}
  </FlowStep>
{:else}
  <form onsubmit={submit}>
  <FlowStep
    headline="Connect from your GitHub"
    description="Ryph acts as @{data.login} on GitHub for everyone who uses it. Pick a repository and choose how its pull requests get opened."
  >
      <Field.FieldGroup>
        <Field.Field>
          <Field.FieldLabel for="repo-search">Repository</Field.FieldLabel>
          {#await data.repos}
            {@render loading()}
          {:then repos}
            {#if repos === null}
              {@render loading()}
            {:else if repos.length === 0}
              <Field.FieldDescription>
                @{data.login} has no repositories on GitHub yet.
              </Field.FieldDescription>
            {:else}
              {@const matches = filterGithubRepos(repos, query)}
              <InputGroup.Root>
                <InputGroup.Addon>
                  <SearchIcon />
                </InputGroup.Addon>
                <InputGroup.Input
                  id="repo-search"
                  bind:value={query}
                  placeholder="Search repositories"
                  autocomplete="off"
                  spellcheck={false}
                />
              </InputGroup.Root>
              {#if matches.shown.length === 0}
                <Field.FieldDescription>No repositories match.</Field.FieldDescription>
              {:else}
                <div
                  class="flex max-h-96 flex-col divide-y overflow-y-auto rounded-lg border"
                  role="radiogroup"
                  aria-label="Repository"
                >
                  {#each matches.shown as repo (repo.fullName)}
                    {#if repo.connectedRepoId}
                      <a
                        href="/repos/{repo.connectedRepoId}"
                        class="hover:bg-muted/50 text-muted-foreground flex items-center gap-2 px-3 py-2.5 text-sm transition-colors"
                      >
                        <CheckIcon class="invisible size-4 shrink-0" />
                        <span class="min-w-0 flex-1 truncate font-medium">{repo.fullName}</span>
                        {#if repo.private}
                          <Badge variant="outline">Private</Badge>
                        {/if}
                        <Badge variant="secondary">Connected</Badge>
                        <ArrowRightIcon class="size-4 shrink-0" />
                      </a>
                    {:else if !repo.admin}
                      <button
                        type="button"
                        role="radio"
                        aria-checked="false"
                        disabled
                        class="text-muted-foreground flex cursor-not-allowed items-center gap-2 px-3 py-2.5 text-left text-sm"
                      >
                        <CheckIcon class="invisible size-4 shrink-0" />
                        <span class="min-w-0 flex-1 truncate font-medium">{repo.fullName}</span>
                        {#if repo.private}
                          <Badge variant="outline">Private</Badge>
                        {/if}
                        <span class="shrink-0 text-xs">Needs admin access</span>
                      </button>
                    {:else}
                      <button
                        type="button"
                        role="radio"
                        aria-checked={picked === repo.fullName}
                        class="hover:bg-muted/50 aria-checked:bg-muted flex items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors"
                        onclick={() => {
                          picked = repo.fullName;
                        }}
                      >
                        <CheckIcon
                          class="size-4 shrink-0 {picked === repo.fullName ? '' : 'invisible'}"
                        />
                        <span class="min-w-0 flex-1 truncate font-medium">{repo.fullName}</span>
                        {#if repo.private}
                          <Badge variant="outline">Private</Badge>
                        {/if}
                      </button>
                    {/if}
                  {/each}
                </div>
                {#if matches.hidden > 0}
                  <Field.FieldDescription>
                    {matches.hidden} more. Search to find them.
                  </Field.FieldDescription>
                {/if}
              {/if}
            {/if}
          {:catch e}
            <Field.FieldError>{githubListFailure(e)}</Field.FieldError>
            <Button variant="outline" class="self-start" onclick={retry} disabled={retrying}>
              {#if retrying}
                <Spinner data-icon="inline-start" />
              {:else}
                <RotateCwIcon data-icon="inline-start" />
              {/if}
              Try again
            </Button>
          {/await}
        </Field.Field>
        <Field.Field>
          <Field.FieldLabel for="submission-policy">Submission policy</Field.FieldLabel>
          <Select.Root type="single" bind:value={submissionPolicy}>
            <Select.Trigger id="submission-policy" class="w-full">
              {policyLabels[submissionPolicy]}
            </Select.Trigger>
            <Select.Content>
              <Select.Group>
                <Select.Item value="require-approval" label="Require approval" />
                <Select.Item value="auto" label="Auto-submit agent submissions" />
              </Select.Group>
            </Select.Content>
          </Select.Root>
          <Field.FieldDescription>
            "Require approval" holds each change for review before a pull request opens.
            "Auto-submit agent submissions" opens one only when the agent explicitly submits its work.
            Leftover work captured when a run ends always waits for human approval.
          </Field.FieldDescription>
        </Field.Field>
      </Field.FieldGroup>

      {#snippet leftActions()}
        <Button variant="ghost" href={backHref}>
          {data.multiForge ? "Back" : "Cancel"}
        </Button>
      {/snippet}

      {#snippet actions()}
        <Button type="submit" disabled={connecting || picked === null}>
          {#if connecting}
            <Spinner data-icon="inline-start" />
          {:else}
            <LinkIcon data-icon="inline-start" />
          {/if}
          Connect
        </Button>
      {/snippet}
    </FlowStep>
</form>
{/if}

{#snippet loading()}
  <div class="flex flex-col gap-2" aria-busy="true">
  <Skeleton class="h-9 w-full" />
  <Skeleton class="h-32 w-full" />
  <span class="sr-only">Loading repositories</span>
</div>
{/snippet}
