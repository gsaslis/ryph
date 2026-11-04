<script lang="ts">
import PageTitle from "$lib/components/page-title/page-title.svelte";
import ArtifactThumbnail from "$lib/components/artifact-thumbnail/artifact-thumbnail.svelte";
import { type ArtifactSummary, getArtifacts } from "$lib/api/artifacts";
import { Button } from "$lib/components/ui/button";
import * as Empty from "$lib/components/ui/empty";
import { Spinner } from "$lib/components/ui/spinner";
import { artifactHref } from "$lib/utils/artifacts";
import { formatDateTime, formatRelativeTime } from "$lib/utils/format";
import AppWindowIcon from "@lucide/svelte/icons/app-window";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

// What "Load more" appended under the load's first page, and where the next page starts. Kept
// apart from the load, so a re-run of it replaces the head and the rest stays.
let more = $state.raw<ArtifactSummary[]>([]);
let moreBefore = $state<string | null | undefined>(undefined);
let loadingMore = $state(false);

const artifacts = $derived.by(() => {
  const head = new Set(data.artifacts.map((a) => a.id));
  return [...data.artifacts, ...more.filter((a) => !head.has(a.id))];
});
const cursor = $derived(moreBefore === undefined ? data.nextBefore : moreBefore);

async function loadMore() {
  if (cursor === null || loadingMore) return;
  loadingMore = true;
  try {
    const page = await getArtifacts(fetch, { before: cursor });
    more = [...more, ...page.artifacts];
    moreBefore = page.nextBefore;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to load more artifacts");
  } finally {
    loadingMore = false;
  }
}
</script>

<svelte:head>
  <title>Artifacts · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-6">
  <PageTitle
    title="Artifacts"
    description="Pages agents published. Everyone on this instance can open them."
  />

  {#if artifacts.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon">
          <AppWindowIcon />
        </Empty.Media>
        <Empty.Title>No artifacts yet</Empty.Title>
        <Empty.Description>
          When an agent publishes a report or an overview, it shows up here. Turn on artifacts in
          an agent's permissions to let it publish.
        </Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {:else}
    <ul class="grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 xl:grid-cols-3">
      {#each artifacts as artifact (artifact.id)}
        <li class="group relative flex min-w-0 flex-col gap-2.5">
          <ArtifactThumbnail
            id={artifact.id}
            version={artifact.currentVersion}
            title="Preview of {artifact.title}"
            class="group-hover:ring-ring/40 aspect-[16/10] w-full rounded-lg border transition-shadow group-hover:ring-2"
          />
          <div class="flex min-w-0 flex-col gap-0.5 px-0.5">
            <a
              href={artifactHref(artifact.id)}
              class="focus-visible:after:ring-ring truncate font-medium outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2"
            >
              {artifact.title}
            </a>
            <div class="text-muted-foreground flex min-w-0 items-baseline justify-between gap-3 text-xs">
              <span class="truncate">{artifact.agent.name ?? "A deleted agent"}</span>
              <time
                datetime={artifact.updatedAt}
                title={formatDateTime(artifact.updatedAt)}
                class="shrink-0 tabular-nums"
              >
                {artifact.currentVersion > 1 ? "Updated" : "Published"}
                {formatRelativeTime(artifact.updatedAt)}
              </time>
            </div>
          </div>
        </li>
      {/each}
    </ul>
    {#if cursor !== null}
      <div class="flex justify-center">
        <Button variant="outline" onclick={loadMore} disabled={loadingMore}>
          {#if loadingMore}
            <Spinner data-icon="inline-start" />
          {/if}
          Load more
        </Button>
      </div>
    {/if}
  {/if}
</div>
