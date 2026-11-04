<script lang="ts">
import { isWebLink } from "$lib/api/forge";
import { disconnectOrgSkillsRepo, type SyncedOverview, syncOrgSkillsRepo } from "$lib/api/skills";
import type { ConnectedRepo, OrgSkillsRepo, SkillsOverview, SkillWarning } from "$lib/api/types";
import ForgeIcon from "$lib/components/forge-icon/forge-icon.svelte";
import ForgeRepoLabel from "$lib/components/forge-repo-label/forge-repo-label.svelte";
import SkillCard from "$lib/components/skill-card/skill-card.svelte";
import * as Alert from "$lib/components/ui/alert";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Collapsible from "$lib/components/ui/collapsible";
import * as Dialog from "$lib/components/ui/dialog";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
import { Spinner } from "$lib/components/ui/spinner";
import { shortCommit } from "$lib/utils/environments";
import { formatDateTime, formatRelativeTime } from "$lib/utils/format";
import { commitUrl, shortDigest, syncAnswerMessage, syncFailureTitle } from "$lib/utils/skills";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import GitBranchIcon from "@lucide/svelte/icons/git-branch";
import HistoryIcon from "@lucide/svelte/icons/history";
import MoreHorizontalIcon from "@lucide/svelte/icons/more-horizontal";
import PencilIcon from "@lucide/svelte/icons/pencil";
import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import UnplugIcon from "@lucide/svelte/icons/unplug";
import { tick } from "svelte";
import { toast } from "svelte-sonner";
import OrgRepoConnect from "./org-repo-connect.svelte";
import OrgRepoGuide from "./org-repo-guide.svelte";

let {
  org,
  repos,
  canManage,
  onchange,
}: {
  org: OrgSkillsRepo;
  /** The deployment's connected repos, for picking another one. */
  repos: ConnectedRepo[];
  canManage: boolean;
  /** Told of the overview every write answers with. */
  onchange: (overview: SkillsOverview) => void;
} = $props();

const current = $derived(org.current);
const nonDefaultBranch = $derived(org.branch !== null && org.branch !== org.repo.defaultBranch);
const syncedCommitUrl = $derived(
  current?.commit ? commitUrl(org.repo, current.commit) : null,
);

/** The warnings about one skill's directory. */
function warningsOf(name: string): SkillWarning[] {
  return (current?.warnings ?? []).filter((w) => w.path === name || w.path.startsWith(`${name}/`));
}
// The rest: directories that never became a skill, and the version as a whole.
const looseWarnings = $derived.by(() => {
  const names = new Set(current?.skills.map((s) => s.name) ?? []);
  return (current?.warnings ?? []).filter((w) => !names.has(w.path.split("/")[0]));
});

// ---- Sync now ----
let syncing = $state(false);

async function syncNow() {
  syncing = true;
  try {
    const answer: SyncedOverview = await syncOrgSkillsRepo(fetch);
    const said = syncAnswerMessage(answer.sync);
    if (said.tone === "error") toast.error(said.message);
    else if (said.tone === "success") toast.success(said.message);
    else toast.info(said.message);
    onchange(answer);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Couldn't sync the repository");
  } finally {
    syncing = false;
  }
}

// ---- change and disconnect ----
let changeOpen = $state(false);
let changeOpener: HTMLElement | null = null;
let actionsTrigger = $state<HTMLElement | null>(null);

function openChange() {
  changeOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  changeOpen = true;
}

// The dialog hands focus back to what opened it, but a save can take that away: picking a
// repository from the disconnected alert ends the alert, button and all, and focus would fall to
// the top of the page. Focus goes to the repository's actions instead, which stay.
function returnFromChange(event: Event) {
  event.preventDefault();
  void tick().then(() => {
    const back = changeOpener?.isConnected ? changeOpener : actionsTrigger;
    back?.focus();
    changeOpener = null;
  });
}
let disconnectOpen = $state(false);
let disconnecting = $state(false);

async function disconnect() {
  disconnecting = true;
  try {
    onchange(await disconnectOrgSkillsRepo(fetch));
    toast.success("Org skills repository disconnected");
    disconnectOpen = false;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Couldn't disconnect the repository");
  } finally {
    disconnecting = false;
  }
}
</script>

<div class="flex flex-col gap-4">
  <!-- The repository: where it lives, which branch is read, and when it was last read. -->
  <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 rounded-lg border px-4 py-3">
    <div class="flex min-w-0 flex-col gap-1.5">
      <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
        <ForgeIcon provider={org.repo.provider} />
        {#if isWebLink(org.repo.url)}
          <a
            href={org.repo.url}
            target="_blank"
            rel="noreferrer noopener"
            class="inline-flex min-w-0 items-center gap-1 underline-offset-4 hover:underline"
          >
            <ForgeRepoLabel repoRef={org.repo.repoRef} provider={org.repo.provider} />
            <ExternalLinkIcon class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
          </a>
        {:else}
          <ForgeRepoLabel repoRef={org.repo.repoRef} provider={org.repo.provider} copy />
        {/if}
        <span
          class="text-muted-foreground inline-flex min-w-0 items-center gap-1 font-mono text-xs font-normal wrap-anywhere"
        >
          <GitBranchIcon class="size-3 shrink-0" aria-hidden="true" />
          {org.effectiveBranch}
        </span>
      </div>
      <p class="text-muted-foreground text-xs">
        {#if current}
          Synced
          <time datetime={current.syncedAt} title={formatDateTime(current.syncedAt)}>
            {formatRelativeTime(current.syncedAt)}
          </time>
          {#if current.commit}
            from
            {#if syncedCommitUrl}
              <a
                href={syncedCommitUrl}
                target="_blank"
                rel="noreferrer noopener"
                class="font-mono underline-offset-4 hover:underline"
              >{shortCommit(current.commit)}</a>
            {:else}
              <span class="font-mono" title={current.commit}>{shortCommit(current.commit)}</span>
            {/if}
          {/if}
        {:else if org.lastFailure}
          Never synced
        {:else}
          Not synced yet
        {/if}
      </p>
      {#if current && org.checkedAt && org.checkedAt !== current.syncedAt}
        <p class="text-muted-foreground text-xs">
          Last checked
          <time datetime={org.checkedAt} title={formatDateTime(org.checkedAt)}>
            {formatRelativeTime(org.checkedAt)}
          </time>
        </p>
      {/if}
      {#if nonDefaultBranch}
        <p class="text-muted-foreground text-xs">
          Not the default branch, so it syncs every hour and when {canManage
            ? "you press"
            : "an admin presses"} Sync now.
        </p>
      {/if}
    </div>
    <div class="flex items-center gap-1">
      <Button variant="ghost" size="sm" href="/skills/syncs">
        <HistoryIcon data-icon="inline-start" />
        History
      </Button>
      {#if canManage}
        {#if !org.archived}
          <Button variant="outline" size="sm" disabled={syncing} onclick={syncNow}>
            {#if syncing}
              <Spinner data-icon="inline-start" />
            {:else}
              <RefreshCwIcon data-icon="inline-start" />
            {/if}
            Sync now
          </Button>
        {/if}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                bind:ref={actionsTrigger}
                variant="ghost"
                size="icon-sm"
                aria-label="Repository actions"
              >
                <MoreHorizontalIcon />
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
            <DropdownMenu.Group>
              <DropdownMenu.Item onclick={openChange}>
                <PencilIcon />
                Change repository
              </DropdownMenu.Item>
              <DropdownMenu.Item variant="destructive" onclick={() => (disconnectOpen = true)}>
                <UnplugIcon />
                Disconnect
              </DropdownMenu.Item>
            </DropdownMenu.Group>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/if}
    </div>
  </div>

  {#if org.archived}
    <Alert.Root variant="destructive">
      <TriangleAlertIcon />
      <Alert.Title>This repository was disconnected on the Repositories page</Alert.Title>
      <Alert.Description>
        <p>
          Agents get no org skills until {canManage ? "you pick" : "an admin picks"} a repository
          again.
        </p>
        {#if canManage}
          <Button variant="outline" size="sm" onclick={openChange}>
            Pick a repository
          </Button>
        {/if}
      </Alert.Description>
    </Alert.Root>
  {:else if org.lastFailure}
    <Alert.Root variant="destructive">
      <TriangleAlertIcon />
      <Alert.Title>{syncFailureTitle(org.lastFailure.kind)}</Alert.Title>
      <Alert.Description>
        {#if org.lastFailure.error}
          <p>{org.lastFailure.error}</p>
        {/if}
        <p>
          {org.lastFailure.repeats > 1 ? `Failed ${org.lastFailure.repeats} times, last` : "Failed"}
          <time datetime={org.lastFailure.at} title={formatDateTime(org.lastFailure.at)}>
            {formatRelativeTime(org.lastFailure.at)}
          </time>.
          {#if org.stale && current}
            Agents use the skills synced {formatRelativeTime(current.syncedAt)} until a sync works.
          {/if}
        </p>
      </Alert.Description>
    </Alert.Root>
  {/if}

  {#if current && current.skills.length > 0}
    {#if org.archived}
      <p class="text-muted-foreground text-sm">Last synced skills. Agents don't get these.</p>
    {/if}
    <div class="@container">
      <ul class="grid gap-4 @xl:grid-cols-2 @4xl:grid-cols-3">
        {#each current.skills as skill (skill.name)}
          {@const warnings = warningsOf(skill.name)}
          <li class="flex">
            <SkillCard
              name={skill.name}
              description={skill.description}
              presentation={skill.presentation}
              href="/skills/org/{encodeURIComponent(skill.name)}"
              off={org.archived}
            >
              {#snippet meta()}
                <Badge
                  variant="outline"
                  class="font-mono font-normal"
                >
                  {shortDigest(skill.digest)}
                </Badge>
                {#if warnings.length > 0}
                  <Badge
                    variant="destructive"
                    class="relative z-10"
                    title={warnings.map((w) => `${w.path}: ${w.message}`).join("\n")}
                  >
                    <TriangleAlertIcon data-icon="inline-start" />
                    {warnings.length} warning{warnings.length === 1 ? "" : "s"}
                  </Badge>
                {/if}
              {/snippet}
            </SkillCard>
          </li>
        {/each}
      </ul>
    </div>
  {:else if current && !org.archived}
    <!-- Not for an archived repo: nothing pushed to it syncs, and the alert above says what does
         bring skills back. -->
    <div class="flex flex-col gap-4 rounded-lg border border-dashed p-4">
      <p class="text-sm">
        No skills on <span class="font-mono">{org.effectiveBranch}</span> yet.
      </p>
      <OrgRepoGuide connected branch={org.effectiveBranch} {nonDefaultBranch} {canManage} />
    </div>
  {/if}

  {#if looseWarnings.length > 0}
    <Collapsible.Root class="group/warnings flex flex-col gap-2">
      <Collapsible.Trigger
        class="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer items-center gap-1 text-sm transition-colors"
      >
        <ChevronRightIcon
          class="size-4 transition-transform group-data-[state=open]/warnings:rotate-90"
        />
        {looseWarnings.length} warning{looseWarnings.length === 1 ? "" : "s"}
      </Collapsible.Trigger>
      <Collapsible.Content>
        <ul class="divide-y rounded-lg border text-sm">
          {#each looseWarnings as warning, i (i)}
            <li class="flex flex-col gap-0.5 px-4 py-2">
              <span class="font-mono text-xs">{warning.path}</span>
              <span class="text-muted-foreground text-xs">{warning.message}</span>
            </li>
          {/each}
        </ul>
      </Collapsible.Content>
    </Collapsible.Root>
  {/if}

</div>

<Dialog.Root bind:open={changeOpen}>
  <Dialog.Content class="sm:max-w-lg" onCloseAutoFocus={returnFromChange}>
    <Dialog.Header>
      <Dialog.Title>Change the org skills repository</Dialog.Title>
      <Dialog.Description>
        Agents switch to the new repository's skills once it syncs.
      </Dialog.Description>
    </Dialog.Header>
    {#if changeOpen}
      <OrgRepoConnect
        {repos}
        repoId={org.archived ? null : org.repo.id}
        branch={org.branch}
        submitLabel="Save"
        oncancel={() => (changeOpen = false)}
        onconnected={(answer) => {
          changeOpen = false;
          onchange(answer);
        }}
      />
    {/if}
  </Dialog.Content>
</Dialog.Root>

<AlertDialog.Root bind:open={disconnectOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Disconnect the org skills repository?</AlertDialog.Title>
      <AlertDialog.Description>
        New runs stop getting its skills. Runs already going keep theirs, and its history stays.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action disabled={disconnecting} onclick={disconnect}>
        {#if disconnecting}
          <Spinner data-icon="inline-start" />
        {/if}
        Disconnect
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
