<script lang="ts">
import { goto, invalidateAll } from "$app/navigation";
import { ApiError } from "$lib/api/call";
import { connectGitlabRepo, type GitlabHook } from "$lib/api/repos";
import type { ConnectedRepo, SubmissionPolicy } from "$lib/api/types";
import FlowStep from "$lib/components/flow-step/flow-step.svelte";
import GitlabHookSteps from "$lib/components/gitlab-hook/gitlab-hook-steps.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Alert from "$lib/components/ui/alert";
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
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import { toast } from "svelte-sonner";
import UnavailableStep from "../unavailable-step.svelte";
import type { PageProps } from "./$types";
import { withBackTo } from "$lib/utils/safe-path";
import {
  filterGitlabProjects,
  gitlabConnectFailure,
  gitlabListFailure,
  unpickable,
} from "./listing";

let { data }: PageProps = $props();

// Where leaving the flow goes: the page that opened it, else the repositories.
const exitHref = $derived(data.backTo ?? "/repos");
const backHref = $derived(data.multiForge ? withBackTo("/repos/connect", data.backTo) : exitHref);
const headline = $derived(
  data.gitlab?.mode === "user" ? "Connect from your GitLab" : "Connect from GitLab",
);

const policyLabels: Record<SubmissionPolicy, string> = {
  "require-approval": "Require approval",
  auto: "Auto-submit agent submissions",
};

let query = $state("");
let picked = $state<{ path: string; webUrl: string } | null>(null);
let submissionPolicy: SubmissionPolicy = $state("require-approval");
let connecting = $state(false);
let retrying = $state(false);

/** What came back from a bot-mode connect: the row, and the webhook still to be added. */
let connected = $state<{ repo: ConnectedRepo; hook: GitlabHook; webUrl: string } | null>(null);

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
  if (!data.gitlab) return;
  if (!picked) {
    toast.error("Pick a project to connect");
    return;
  }
  connecting = true;
  try {
    const { repo, webhook } = await connectGitlabRepo(fetch, {
      repoRef: picked.path,
      submissionPolicy,
    });
    toast.success(`Connected ${repo.repoRef}`);
    // User mode takes no webhooks (merges are polled), so it is done; a bot-mode project has one
    // more step, on GitLab.
    if (webhook === null) await goto(data.backTo ?? `/repos/${repo.id}`);
    else connected = { repo, hook: webhook, webUrl: picked.webUrl };
  } catch (e) {
    toast.error(gitlabConnectFailure(e, data.gitlab));
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
  <title>{headline} · Ryph</title>
</svelte:head>

{#if data.unavailable || !data.gitlab}
  <UnavailableStep {headline} {exitHref} />
{:else if connected}
  <FlowStep
  headline="Add the webhook on GitLab"
  description="{connected.repo.repoRef} is connected. Add this webhook so /ryph comments, merge requests and pushes reach Ryph."
>
    <GitlabHookSteps hook={connected.hook} webUrl={connected.webUrl} />

    {#snippet actions()}
      <Button href={data.backTo ?? `/repos/${connected?.repo.id}`}>Done</Button>
    {/snippet}
  </FlowStep>
{:else if !data.allowed}
  <FlowStep
  {headline}
  description="Ryph acts as @{data.gitlab.login} on GitLab for everyone here, so only admins can connect repositories."
>
    {#snippet leftActions()}
      <Button variant="ghost" href={backHref}>
        {data.multiForge ? "Back" : "Cancel"}
      </Button>
    {/snippet}
  </FlowStep>
{:else}
  {@const gitlab = data.gitlab}
  <form onsubmit={submit}>
  <FlowStep
    {headline}
    description={gitlab.mode === "user"
        ? `Ryph acts as @${gitlab.login} on GitLab for everyone who uses it. Pick a project and choose how its merge requests get opened.`
        : `Ryph works through @${gitlab.login}, which sees the projects it is a member of. Pick one you maintain and choose how its merge requests get opened.`}
  >
      {#if data.needsLink}
        <Alert.Root>
          <TriangleAlertIcon />
          {#if gitlab.signIn}
            <Alert.Title>Link your GitLab account first</Alert.Title>
            <Alert.Description class="flex flex-col gap-3">
              <span>Ryph checks that you maintain the project through it.</span>
              <Button
                variant="outline"
                size="sm"
                href="/auth/oauth/gitlab/start?intent=link"
              >
                <LinkIcon data-icon="inline-start" />
                Link GitLab
              </Button>
            </Alert.Description>
          {:else}
            <Alert.Title>GitLab sign-in isn't set up</Alert.Title>
            <Alert.Description>
              Connecting needs a linked GitLab account, and nobody can link one here yet. An
              admin can add a GitLab OAuth application.
            </Alert.Description>
          {/if}
        </Alert.Root>
      {/if}
      <Field.FieldGroup>
        <Field.Field>
          <Field.FieldLabel for="project-search">Project</Field.FieldLabel>
          {#await data.projects}
            {@render loading()}
          {:then projects}
            {#if projects === null}
              {@render loading()}
            {:else if projects.length === 0}
              <Field.FieldDescription>
                {#if gitlab.mode === "user"}
                  @{gitlab.login} has no projects on GitLab yet.
                {:else}
                  @{gitlab.login} is not a member of any project yet. Add it to a project or group
                  on GitLab with the Developer role, then try again.
                {/if}
              </Field.FieldDescription>
              <Button variant="outline" class="self-start" onclick={retry} disabled={retrying}>
                {#if retrying}
                  <Spinner data-icon="inline-start" />
                {:else}
                  <RotateCwIcon data-icon="inline-start" />
                {/if}
                Try again
              </Button>
            {:else}
              {@const matches = filterGitlabProjects(projects, query)}
              <InputGroup.Root>
                <InputGroup.Addon>
                  <SearchIcon />
                </InputGroup.Addon>
                <InputGroup.Input
                  id="project-search"
                  bind:value={query}
                  placeholder="Search projects"
                  autocomplete="off"
                  spellcheck={false}
                />
              </InputGroup.Root>
              {#if matches.shown.length === 0}
                <Field.FieldDescription>No projects match.</Field.FieldDescription>
              {:else}
                <div
                  class="flex max-h-96 flex-col divide-y overflow-y-auto rounded-lg border"
                  role="radiogroup"
                  aria-label="Project"
                >
                  {#each matches.shown as project (project.id)}
                    {@const refusal = unpickable(project, gitlab.mode)}
                    {#if project.connectedRepoId}
                      <a
                        href="/repos/{project.connectedRepoId}"
                        class="hover:bg-muted/50 text-muted-foreground flex items-center gap-2 px-3 py-2.5 text-sm transition-colors"
                      >
                        <CheckIcon class="invisible size-4 shrink-0" />
                        <span class="min-w-0 flex-1 truncate font-medium">
                          {project.pathWithNamespace}
                        </span>
                        {@render visibility(project.visibility)}
                        <Badge variant="secondary">Connected</Badge>
                        <ArrowRightIcon class="size-4 shrink-0" />
                      </a>
                    {:else if refusal !== null}
                      <button
                        type="button"
                        role="radio"
                        aria-checked="false"
                        disabled
                        class="text-muted-foreground flex cursor-not-allowed items-center gap-2 px-3 py-2.5 text-left text-sm"
                      >
                        <CheckIcon class="invisible size-4 shrink-0" />
                        <span class="min-w-0 flex-1 truncate font-medium">
                          {project.pathWithNamespace}
                        </span>
                        {@render visibility(project.visibility)}
                        <span class="shrink-0 text-xs">{refusal}</span>
                      </button>
                    {:else}
                      <button
                        type="button"
                        role="radio"
                        aria-checked={picked?.path === project.pathWithNamespace}
                        class="hover:bg-muted/50 aria-checked:bg-muted flex items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors"
                        onclick={() => {
                          picked = { path: project.pathWithNamespace, webUrl: project.webUrl };
                        }}
                      >
                        <CheckIcon
                          class={[
                            "size-4 shrink-0",
                            picked?.path !== project.pathWithNamespace && "invisible",
                          ]}
                        />
                        <span class="min-w-0 flex-1 truncate font-medium">
                          {project.pathWithNamespace}
                        </span>
                        {@render visibility(project.visibility)}
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
            <Field.FieldError>{gitlabListFailure(e)}</Field.FieldError>
            <Button variant="outline" class="self-start" onclick={retry} disabled={retrying}>
              {#if retrying}
                <Spinner data-icon="inline-start" />
              {:else}
                <RotateCwIcon data-icon="inline-start" />
              {/if}
              Try again
            </Button>
          {/await}
          {#if gitlab.mode === "bot"}
            <Field.FieldDescription>
              Missing one? Add @{gitlab.login} to it on GitLab as a Developer, not a Maintainer.
            </Field.FieldDescription>
          {/if}
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
            "Require approval" holds each change for review before a merge request opens.
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
        <Button type="submit" disabled={connecting || picked === null || data.needsLink}>
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

{#snippet visibility(level: "public" | "internal" | "private")}
  {#if level !== "public"}
    <Badge variant="outline">{level === "private" ? "Private" : "Internal"}</Badge>
  {/if}
{/snippet}

{#snippet loading()}
  <div class="flex flex-col gap-2" aria-busy="true">
  <Skeleton class="h-9 w-full" />
  <Skeleton class="h-32 w-full" />
  <span class="sr-only">Loading projects</span>
</div>
{/snippet}
