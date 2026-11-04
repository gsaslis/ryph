<script lang="ts">
import { getSkillSyncs } from "$lib/api/skills";
import type { SkillSync } from "$lib/api/types";
import ForgeRepoLabel from "$lib/components/forge-repo-label/forge-repo-label.svelte";
import PageTitle from "$lib/components/page-title/page-title.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Collapsible from "$lib/components/ui/collapsible";
import * as Empty from "$lib/components/ui/empty";
import { Spinner } from "$lib/components/ui/spinner";
import { shortCommit } from "$lib/utils/environments";
import { formatDateTime, formatRelativeTime } from "$lib/utils/format";
import { commitUrl, skillCount, SYNC_TRIGGER_LABEL, syncFailureTitle } from "$lib/utils/skills";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import GitBranchIcon from "@lucide/svelte/icons/git-branch";
import HistoryIcon from "@lucide/svelte/icons/history";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

// The load's first page, and every page after it that "Show more" fetched.
let syncs = $derived<SkillSync[]>(data.syncs);
let cursor = $derived(data.nextCursor);
let loading = $state(false);

async function more() {
  if (cursor === null) return;
  loading = true;
  try {
    const next = await getSkillSyncs(fetch, { cursor });
    // A row that landed between two pages could be in both; it is shown once.
    const seen = new Set(syncs.map((s) => s.id));
    syncs = [...syncs, ...next.syncs.filter((s) => !seen.has(s.id))];
    cursor = next.nextCursor;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Couldn't load more syncs");
  } finally {
    loading = false;
  }
}

const repoOf = $derived(new Map(data.repos.map((r) => [r.id, r])));

function linkOf(sync: SkillSync): string | null {
  const repo = repoOf.get(sync.connectedRepoId);
  return repo && sync.commit ? commitUrl(repo, sync.commit) : null;
}
</script>

<svelte:head>
  <title>Sync history · Skills · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-8">
  <PageTitle title="Sync history">
    {#snippet description()}
      Each time the org skills repository changed, or couldn't be read. Reads that found nothing new
      aren't listed.
    {/snippet}
  </PageTitle>

  {#if syncs.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon">
          <HistoryIcon />
        </Empty.Media>
        <Empty.Title>No syncs yet</Empty.Title>
        <Empty.Description>They show here once an org skills repository is connected.</Empty.Description>
      </Empty.Header>
      <Empty.Content>
        <Button variant="outline" size="sm" href="/skills">Back to Skills</Button>
      </Empty.Content>
    </Empty.Root>
  {:else}
    <ol class="divide-y rounded-lg border">
      {#each syncs as sync (sync.id)}
        {@const link = linkOf(sync)}
        <li class="flex flex-col gap-1.5 px-4 py-3">
          <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <div class="flex flex-wrap items-center gap-2">
              {#if sync.outcome === "synced"}
                <Badge variant="secondary">Synced</Badge>
              {:else if sync.outcome === "failed"}
                <Badge variant="destructive">{syncFailureTitle(sync.failure)}</Badge>
              {:else}
                <Badge variant="outline">Superseded</Badge>
              {/if}
              <span class="text-muted-foreground text-xs">{SYNC_TRIGGER_LABEL[sync.trigger]}</span>
            </div>
            <time
              class="text-muted-foreground text-xs"
              datetime={sync.finishedAt}
              title={formatDateTime(sync.finishedAt)}
            >
              {formatRelativeTime(sync.finishedAt)}
            </time>
          </div>
          <div class="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <ForgeRepoLabel repoRef={sync.repoRef} fallback={sync.connectedRepoId} />
            <span class="inline-flex items-center gap-1 font-mono">
              <GitBranchIcon class="size-3" aria-hidden="true" />
              {sync.branch}
            </span>
            {#if sync.commit}
              {#if link}
                <a
                  href={link}
                  target="_blank"
                  rel="noreferrer noopener"
                  class="font-mono underline-offset-4 hover:underline"
                >{shortCommit(sync.commit)}</a>
              {:else}
                <span class="font-mono" title={sync.commit}>{shortCommit(sync.commit)}</span>
              {/if}
            {/if}
            {#if sync.outcome === "synced" || (sync.outcome === "superseded" && sync.failure === null)}
              <span>{skillCount(sync.skillCount)}</span>
            {/if}
          </div>
          <!-- A read is superseded when a later one answered first or the settings moved to another
               repository or branch while it ran, and the row does not say which, so the line covers
               both. Its error changed nothing either, so it is not shown as a failure. -->
          {#if sync.outcome === "superseded"}
            <p class="text-muted-foreground text-xs">
              Changed nothing: a later sync or a change of repository or branch came first.
            </p>
          {/if}
          {#if sync.error}
            <p
              class={[
                "text-xs wrap-anywhere",
                sync.outcome === "superseded" ? "text-muted-foreground" : "text-destructive",
              ]}
            >
              {sync.error}
              {#if sync.repeats > 1}
                <span class="text-muted-foreground">
                  ({sync.repeats} times since {formatDateTime(sync.startedAt)})
                </span>
              {/if}
            </p>
          {/if}
          {#if sync.warnings.length > 0}
            <Collapsible.Root class="group/warnings flex flex-col gap-1.5">
              <Collapsible.Trigger
                class="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer items-center gap-1 text-xs transition-colors"
              >
                <ChevronRightIcon
                  class="size-3.5 transition-transform group-data-[state=open]/warnings:rotate-90"
                />
                {sync.warnings.length} warning{sync.warnings.length === 1 ? "" : "s"}
              </Collapsible.Trigger>
              <Collapsible.Content>
                <ul class="flex flex-col gap-1 pl-5 text-xs">
                  {#each sync.warnings as warning, i (i)}
                    <li>
                      <span class="font-mono">{warning.path}</span>
                      <span class="text-muted-foreground">{warning.message}</span>
                    </li>
                  {/each}
                </ul>
              </Collapsible.Content>
            </Collapsible.Root>
          {/if}
        </li>
      {/each}
    </ol>
    {#if cursor !== null}
      <div>
        <Button variant="outline" disabled={loading} onclick={more}>
          {#if loading}
            <Spinner data-icon="inline-start" />
          {/if}
          Show more
        </Button>
      </div>
    {/if}
  {/if}
</div>
