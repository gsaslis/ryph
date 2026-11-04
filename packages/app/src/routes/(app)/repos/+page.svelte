<script lang="ts">
import PageTitle from "$lib/components/page-title/page-title.svelte";
import { invalidate } from "$app/navigation";
import { isWebLink } from "$lib/api/forge";
import { archiveConnectedRepo } from "$lib/api/repos";
import type { ConnectedRepo } from "$lib/api/types";
import ForgeIcon from "$lib/components/forge-icon/forge-icon.svelte";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Card from "$lib/components/ui/card";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
import * as Empty from "$lib/components/ui/empty";
import { Skeleton } from "$lib/components/ui/skeleton";
import { Spinner } from "$lib/components/ui/spinner";
import { deliveredAs, localRepoName, reposReach, shortenRid } from "$lib/utils/forge";
import { gitlabProjectPage } from "$lib/utils/gitlab";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import FolderGit2Icon from "@lucide/svelte/icons/folder-git-2";
import GitBranchIcon from "@lucide/svelte/icons/git-branch";
import MoreHorizontalIcon from "@lucide/svelte/icons/more-horizontal";
import PlusIcon from "@lucide/svelte/icons/plus";
import SettingsIcon from "@lucide/svelte/icons/settings";
import UnplugIcon from "@lucide/svelte/icons/unplug";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

// A deployment may run Radicle alone, or only take repos on this machine, and then nothing on
// this page should mention GitHub or GitLab.
const reach = $derived(reposReach(data.providers, data.githubLogin !== null, data.radicleMine));

/** Where a card's "Open on …" goes: GitLab's row carries the clone URL, whose page is the same
 * path without `.git`. */
function repoPage(repo: ConnectedRepo): string {
  return repo.provider === "gitlab" ? gitlabProjectPage(repo.url) : repo.url;
}

const openLabels: Record<ConnectedRepo["provider"], string> = {
  github: "Open on GitHub",
  gitlab: "Open on GitLab",
  radicle: "Open in explorer",
  local: "Open in explorer",
};

let disconnectTarget: ConnectedRepo | null = $state(null);
let disconnecting = $state(false);

async function submitDisconnect() {
  if (!disconnectTarget) return;
  disconnecting = true;
  try {
    await archiveConnectedRepo(fetch, disconnectTarget.id);
    toast.success(`Disconnected ${disconnectTarget.repoRef}`);
    disconnectTarget = null;
    await invalidate("app:repos");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to disconnect repository");
  } finally {
    disconnecting = false;
  }
}
</script>

<svelte:head>
  <title>Repos · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-6">
  <PageTitle title="Repos">
    {#snippet description()}
      {reach ? `Repositories agents can work on, ${reach}.` : "Repositories agents can work on."}
      {#if data.githubLogin}
        Ryph acts as @{data.githubLogin} on GitHub for everyone who uses it.
      {/if}
      {#if data.gitlab}
        Ryph acts as @{data.gitlab.login} on GitLab{data.gitlab.mode === "user"
          ? " for everyone who uses it"
          : ""}.
      {/if}
    {/snippet}
  </PageTitle>

  {#if data.repos.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon">
          <FolderGit2Icon />
        </Empty.Media>
        <Empty.Title>No repositories yet</Empty.Title>
        <Empty.Description>
          Connect one to let agents open {deliveredAs(data.providers)} against it.
        </Empty.Description>
      </Empty.Header>
      <Empty.Content>
        <Button href="/repos/connect">
          <PlusIcon data-icon="inline-start" />
          Connect repository
        </Button>
      </Empty.Content>
    </Empty.Root>
  {:else}
    <!-- Cards, as agents and tool servers are. The whole card opens the repo's settings: the
         title is the link and its ::after is stretched over the card (`relative` anchors it),
         with the menu raised above that layer. -->
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {#each data.repos as repo (repo.id)}
        {@render repoCard(repo)}
      {/each}
      <a
        href="/repos/connect"
        class="text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:ring-ring/50 flex min-h-40 items-center justify-center gap-2 rounded-xl border border-dashed text-sm transition-colors outline-none focus-visible:ring-[3px]"
      >
        <PlusIcon class="size-4" />
        Connect repository
      </a>
    </div>
  {/if}
</div>

{#snippet repoCard(repo: ConnectedRepo)}
  <Card.Root
  size="sm"
  class="@container/card from-foreground/5 to-card relative bg-linear-to-t transition-shadow hover:ring-foreground/25 has-[a:focus-visible]:ring-ring/50 has-[a:focus-visible]:ring-[3px]"
>
  <Card.Header>
    <div class="flex min-w-0 flex-col gap-4">
      <div
        class="bg-background ring-border flex size-12 shrink-0 items-center justify-center rounded-lg ring-1"
      >
        <ForgeIcon provider={repo.provider} class="size-6" />
      </div>
      <Card.Title class="truncate">
        <a
          href="/repos/{repo.id}"
          class="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
        >
            {#if repo.provider === "radicle"}
              {#await data.radicleNames[repo.id]}
                <Skeleton class="inline-block h-4 w-32 align-middle" />
                <span class="sr-only">{repo.repoRef}</span>
              {:then name}
                <span title={name ?? repo.repoRef}>{name ?? shortenRid(repo.repoRef)}</span>
              {/await}
            {:else if repo.provider === "local"}
              <!-- The folder's name; the whole path is on the line below. -->
              <span title={repo.repoRef}>{localRepoName(repo.repoRef)}</span>
            {:else}
              <!-- The owner (or GitLab's groups) is on the line below, with the rest of the address. -->
              <span title={repo.repoRef}>{repo.repoRef.split("/").at(-1)}</span>
            {/if}
          </a>
      </Card.Title>
    </div>
    <Card.Action class="relative z-10 flex items-center gap-1">
      <!-- Only the exception is marked: waiting for approval is the default, and a lone
           "Approval" badge did not say whose approval, or of what. -->
      <!-- Where every repo is on this machine, saying so on each card says nothing. -->
      {#if repo.provider === "local" && data.providers.length > 1}
        <Badge variant="outline">On this machine</Badge>
      {/if}
      {#if repo.submissionPolicy === "auto"}
        <Badge variant="secondary" title="Finished runs submit their work without review">
          Auto-submit
        </Badge>
      {/if}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button {...props} variant="ghost" size="icon-sm" aria-label="Repository actions">
                <MoreHorizontalIcon />
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          <DropdownMenu.Group>
              <DropdownMenu.Item>
                {#snippet child({ props })}
                  <a {...props} href="/repos/{repo.id}">
                    <SettingsIcon />
                    Settings
                  </a>
                {/snippet}
              </DropdownMenu.Item>
              <!-- A Radicle deployment may have no explorer, and then there is nowhere to go. -->
              {#if isWebLink(repoPage(repo))}
                <DropdownMenu.Item>
                  {#snippet child({ props })}
                    <a {...props} href={repoPage(repo)} target="_blank" rel="noreferrer">
                      <ExternalLinkIcon />
                      {openLabels[repo.provider]}
                    </a>
                  {/snippet}
                </DropdownMenu.Item>
              {/if}
            </DropdownMenu.Group>
          <DropdownMenu.Separator />
          <DropdownMenu.Group>
            <DropdownMenu.Item variant="destructive" onclick={() => (disconnectTarget = repo)}>
                <UnplugIcon />
                Disconnect
              </DropdownMenu.Item>
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </Card.Action>
  </Card.Header>
  <Card.Content class="mt-auto flex flex-col gap-1">
    <!-- The address, under the name: GitHub's owner/name, GitLab's group path, Radicle's RID, a
         local repo's path. -->
    <Card.Description
      class={[
        "truncate text-xs",
        repo.provider !== "github" && repo.provider !== "gitlab" && "font-mono",
      ]}
      title={repo.repoRef}
    >
        {repo.repoRef}
      </Card.Description>
    <Card.Description class="flex items-center gap-1 text-xs">
      <GitBranchIcon class="size-3.5 shrink-0" />
      <span class="truncate">{repo.defaultBranch}</span>
    </Card.Description>
  </Card.Content>
</Card.Root>
{/snippet}

<AlertDialog.Root
  open={disconnectTarget !== null}
  onOpenChange={(open) => {
    if (!open) disconnectTarget = null;
  }}
>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Disconnect {disconnectTarget?.repoRef}?</AlertDialog.Title>
      <AlertDialog.Description>
        New tasks can't target it, and its pending patches stop submitting. Nothing changes {disconnectTarget?.provider ===
          "local"
          ? "in the repository itself"
          : "on the forge"}, and you can reconnect it at any time.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action disabled={disconnecting} onclick={submitDisconnect}>
        {#if disconnecting}
          <Spinner data-icon="inline-start" />
        {/if}
        Disconnect
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
