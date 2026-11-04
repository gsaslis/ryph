<script lang="ts">
import { env } from "$env/dynamic/public";
import { goto } from "$app/navigation";
import { connectRepo } from "$lib/api/repos";
import { withBackTo } from "$lib/utils/safe-path";
import type { SubmissionPolicy } from "$lib/api/types";
import FlowStep from "$lib/components/flow-step/flow-step.svelte";
import ForgeIcon from "$lib/components/forge-icon/forge-icon.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Field from "$lib/components/ui/field";
import * as Select from "$lib/components/ui/select";
import { Spinner } from "$lib/components/ui/spinner";
import CheckIcon from "@lucide/svelte/icons/check";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import FolderGit2Icon from "@lucide/svelte/icons/folder-git-2";
import LaptopIcon from "@lucide/svelte/icons/laptop";
import LinkIcon from "@lucide/svelte/icons/link-2";
import SproutIcon from "@lucide/svelte/icons/sprout";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";
import UnavailableStep from "./unavailable-step.svelte";

let { data }: PageProps = $props();

const installUrl = `https://github.com/apps/${env.PUBLIC_GITHUB_APP_NAME}/installations/new`;
// GitHub hands `state` back to the setup URL (the callback step), which is how a flow entered from
// elsewhere still returns there after the install.
const installHref = $derived(
  data.backTo ? `${installUrl}?state=${encodeURIComponent(data.backTo)}` : installUrl,
);
// Where leaving the flow goes: the page that opened it, else the repositories.
const exitHref = $derived(data.backTo ?? "/repos");

const policyLabels: Record<SubmissionPolicy, string> = {
  "require-approval": "Require approval",
  auto: "Auto-submit agent submissions",
};

let repoRef = $state("");
let submissionPolicy: SubmissionPolicy = $state("require-approval");
let connecting = $state(false);

async function submit(event: SubmitEvent) {
  event.preventDefault();
  if (!data.installationId) return;
  if (!repoRef) {
    toast.error("Pick a repository to connect");
    return;
  }
  connecting = true;
  try {
    const repo = await connectRepo(fetch, {
      installationId: data.installationId,
      repoRef,
      submissionPolicy,
    });
    toast.success(`Connected ${repo.repoRef}`);
    await goto(exitHref);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to connect repository");
  } finally {
    connecting = false;
  }
}
</script>

<svelte:head>
  <title>Connect repository · Ryph</title>
</svelte:head>

{#if data.unavailable}
  <UnavailableStep {exitHref} />
{:else if data.choose}
  <!-- Asked only where this deployment offers more than one way in; with GitHub alone the flow
       starts one screen further in. -->
  <FlowStep headline="Connect a repository" description="Where does this repository live?">
    <div class="flex flex-col divide-y overflow-hidden rounded-lg border">
      {#if data.providers.includes("github") && data.githubLogin}
        <a
          href={withBackTo("/repos/connect/github", data.backTo)}
          class="hover:bg-muted/50 flex items-start gap-3 px-3 py-3 text-sm transition-colors"
        >
          <FolderGit2Icon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <span class="flex min-w-0 flex-col gap-0.5">
            <span class="font-medium">From your GitHub</span>
            <span class="text-muted-foreground">
              As @{data.githubLogin}. Work arrives as pull requests.
            </span>
          </span>
        </a>
      {:else if data.providers.includes("github")}
        <a
          href={withBackTo("/repos/connect?provider=github", data.backTo)}
          class="hover:bg-muted/50 flex items-start gap-3 px-3 py-3 text-sm transition-colors"
        >
          <FolderGit2Icon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <span class="flex min-w-0 flex-col gap-0.5">
            <span class="font-medium">GitHub</span>
            <span class="text-muted-foreground">
              Through the GitHub App. Work arrives as pull requests.
            </span>
          </span>
        </a>
      {/if}
      {#if data.gitlab}
        <a
          href={withBackTo("/repos/connect/gitlab", data.backTo)}
          class="hover:bg-muted/50 flex items-start gap-3 px-3 py-3 text-sm transition-colors"
        >
          <ForgeIcon provider="gitlab" class="text-muted-foreground mt-0.5" />
          <span class="flex min-w-0 flex-col gap-0.5">
            <span class="font-medium">
              {data.gitlab.mode === "user" ? "From your GitLab" : "GitLab"}
            </span>
            <span class="text-muted-foreground">
              As @{data.gitlab.login}. Work arrives as merge requests.
            </span>
          </span>
        </a>
      {/if}
      {#if data.providers.includes("radicle")}
        <a
          href={withBackTo("/repos/connect/radicle", data.backTo)}
          class="hover:bg-muted/50 flex items-start gap-3 px-3 py-3 text-sm transition-colors"
        >
          <SproutIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <span class="flex min-w-0 flex-col gap-0.5">
            <span class="font-medium">Radicle</span>
            <span class="text-muted-foreground">
              {#if data.radicleMine}
                As this machine's Radicle identity, by repository id. Work arrives as patches.
              {:else}
                Through Ryph's own Radicle node, by repository id. Work arrives as patches.
              {/if}
            </span>
          </span>
        </a>
      {/if}
      {#if data.providers.includes("local")}
        <a
          href={withBackTo("/repos/connect/local", data.backTo)}
          class="hover:bg-muted/50 flex items-start gap-3 px-3 py-3 text-sm transition-colors"
        >
          <LaptopIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <span class="flex min-w-0 flex-col gap-0.5">
            <span class="font-medium">On this machine</span>
            <span class="text-muted-foreground">
              A git repository on the computer Ryph runs on. Work arrives as branches in it.
            </span>
          </span>
        </a>
      {/if}
    </div>

    {#snippet leftActions()}
      <Button variant="ghost" href={exitHref}>Cancel</Button>
    {/snippet}
  </FlowStep>
{:else if data.listing}
  <form onsubmit={submit}>
  <FlowStep
    headline="Connect a repository"
    description="Pick a repository the {data.listing.accountLogin} installation grants and choose how its patches get submitted."
  >
      <Field.FieldGroup>
        <Field.Field>
          <Field.FieldLabel>Repository</Field.FieldLabel>
          {#if data.listing.repos.length === 0}
            <Field.FieldDescription>
              This installation grants no repositories —
              <a
                href={data.listing.settingsUrl ?? installUrl}
                class="underline underline-offset-4"
              >
                adjust its access on GitHub
              </a> first.
            </Field.FieldDescription>
          {:else}
            <div class="flex flex-col divide-y overflow-hidden rounded-lg border" role="radiogroup">
              {#each data.listing.repos as repo (repo.fullName)}
                <button
                  type="button"
                  role="radio"
                  aria-checked={repoRef === repo.fullName}
                  disabled={repo.connected}
                  class="hover:bg-muted/50 aria-checked:bg-muted flex items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  onclick={() => {
                    repoRef = repo.fullName;
                  }}
                >
                  <CheckIcon
                    class="size-4 shrink-0 {repoRef === repo.fullName ? '' : 'invisible'}"
                  />
                  <span class="min-w-0 flex-1 truncate font-medium">{repo.fullName}</span>
                  {#if repo.private}
                    <Badge variant="outline">Private</Badge>
                  {/if}
                  {#if repo.connected}
                    <Badge variant="secondary">Connected</Badge>
                  {/if}
                </button>
              {/each}
            </div>
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
            "Require approval" holds every patch for human review before a pull request opens.
            "Auto-submit agent submissions" opens one only when the agent explicitly submits its work.
            Leftover work captured when a run ends always waits for human approval.
          </Field.FieldDescription>
        </Field.Field>
      </Field.FieldGroup>

      {#snippet leftActions()}
        <Button variant="ghost" href={withBackTo("/repos/connect", data.backTo)}>Back</Button>
      {/snippet}

      {#snippet actions()}
        <Button type="submit" disabled={connecting}>
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
{:else}
  <FlowStep
  headline="Connect a repository"
  description="Repositories reach Ryph through the GitHub App — install it, or reuse an installation that is already registered."
>
    <div class="flex flex-col gap-6">
      <Button href={installHref} class="self-start">
        <ExternalLinkIcon data-icon="inline-start" />
        Install the GitHub App
      </Button>
      {#if data.installations && data.installations.length > 0}
        <div class="flex flex-col gap-2">
          <p class="text-muted-foreground text-sm">Or pick a registered installation:</p>
          <div class="flex flex-col divide-y overflow-hidden rounded-lg border">
            {#each data.installations as installation (installation.id)}
              <a
                href={withBackTo(
                  `/repos/connect?installationId=${encodeURIComponent(installation.installationId)}`,
                  data.backTo,
                )}
                class="hover:bg-muted/50 flex items-center gap-2 px-3 py-2.5 text-sm transition-colors"
              >
                <FolderGit2Icon class="text-muted-foreground size-4 shrink-0" />
                <span class="min-w-0 flex-1 truncate font-medium">
                  {installation.accountLogin}
                </span>
                <span class="text-muted-foreground font-mono text-xs">
                  #{installation.installationId}
                </span>
              </a>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    {#snippet leftActions()}
      <!-- Back to the forge choice where there was one to make; out of the flow where there was not. -->
      <Button
        variant="ghost"
        href={data.providers.length > 1 ? withBackTo("/repos/connect", data.backTo) : exitHref}
      >
        {data.providers.length > 1 ? "Back" : "Cancel"}
      </Button>
    {/snippet}
  </FlowStep>
{/if}
