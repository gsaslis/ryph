<script lang="ts">
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { listBuilds } from "$lib/api/environments";
import type { BuildListItem } from "$lib/api/types";
import BuildStatusBadge from "$lib/components/build-status-badge/build-status-badge.svelte";
import ForgeRepoLabel from "$lib/components/forge-repo-label/forge-repo-label.svelte";
import PageTable, { edgeEnd, edgeStart } from "$lib/components/page-table/page-table.svelte";
import PageTitle from "$lib/components/page-title/page-title.svelte";
import { Button } from "$lib/components/ui/button";
import * as Empty from "$lib/components/ui/empty";
import * as Select from "$lib/components/ui/select";
import { Spinner } from "$lib/components/ui/spinner";
import * as Table from "$lib/components/ui/table";
import {
  buildDurationMs,
  buildKindLabel,
  builtFromLabel,
  isBuildActive,
  triggerLabel,
} from "$lib/utils/environments";
import { formatDateTime, formatElapsed, formatRelativeTime } from "$lib/utils/format";
import { refreshWhileLive } from "$lib/utils/live-refresh.svelte.js";
import ContainerIcon from "@lucide/svelte/icons/container";
import GitBranchIcon from "@lucide/svelte/icons/git-branch";
import LayersIcon from "@lucide/svelte/icons/layers";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";
import type { StateFilter } from "./filters";
import { appendBuildPage, type DeeperBuilds, mergeBuildHead } from "./recent";

let { data }: PageProps = $props();

const STATE_LABELS: Record<StateFilter, string> = {
  any: "Any state",
  active: "Queued or building",
  ready: "Ready",
  failed: "Failed",
};
const ANY_SUBJECT = "all";

const subjectByValue = $derived(new Map(data.subjects.map((s) => [s.value, s])));

/** Narrows the list: the filter lands in the address, and the load reads it from there. */
function setFilter(key: "state" | "subject", value: string, fallback: string) {
  const url = new URL(page.url);
  if (value === fallback) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  void goto(url, { keepFocus: true, noScroll: true, replaceState: true });
}

const filtered = $derived(data.filters.subject !== null || data.filters.state !== "any");

// The list as it is on screen: the load's page and whatever "Load more" appended beneath it,
// held per filter so the poll below keeps the pages the reader asked for.
const filterKey = $derived(`${data.filters.subject ?? ""}|${data.filters.state}`);
let deeper = $state<DeeperBuilds | null>(null);
const held = $derived(deeper !== null && deeper.key === filterKey ? deeper : null);
const recent = $derived(mergeBuildHead(held, { builds: data.builds, nextCursor: data.nextCursor }));

let loadingMore = $state(false);
async function loadMore() {
  const cursor = recent.nextCursor;
  if (cursor === null || loadingMore) return;
  loadingMore = true;
  const key = filterKey;
  try {
    const next = await listBuilds(fetch, data.filters, { cursor });
    // The filters changed while this was in flight: these rows answer another list.
    if (key !== filterKey) return;
    deeper = appendBuildPage(held, key, data.builds, next);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to load more builds");
  } finally {
    loadingMore = false;
  }
}

// Only the head re-reads, so only its rows can settle.
const live = $derived(data.builds.some((item) => isBuildActive(item.build.status)));
refreshWhileLive("app:builds", () => live);

// How long each build took, or has been going: the bars in the last column but one are drawn
// against the longest on screen, so a full build stands out from the incremental ones beside it.
// Read again on every poll, which is what moves a running build's bar.
const durations = $derived.by(() => {
  const now = Date.now();
  return new Map(recent.builds.map((item) => {
    const { build } = item;
    const took = buildDurationMs(build) ??
      (build.status === "building" && build.startedAt !== null
        ? Math.max(0, now - Date.parse(build.startedAt))
        : null);
    return [build.id, took];
  }));
});
const longest = $derived(Math.max(1, ...[...durations.values()].map((ms) => ms ?? 0)));
</script>

<svelte:head>
  <title>Builds · Ryph</title>
</svelte:head>

{#snippet columns()}
  <colgroup>
  <!-- Include the page gutter and the full setup-warning badge, not just short states. -->
  <col class="w-[calc(--spacing(48)_+_var(--side))]" />
  <col />
  <col class="w-[24%]" />
  <col class="w-44" />
  <col class="w-[calc(--spacing(28)_+_var(--side))]" />
</colgroup>
{/snippet}

{#snippet headings()}
  <Table.Row class="bg-muted/40 hover:bg-muted/40">
  <Table.Head class={edgeStart}>State</Table.Head>
  <Table.Head>Built for</Table.Head>
  <Table.Head>Kind</Table.Head>
  <Table.Head class="text-right">Took</Table.Head>
  <Table.Head class={["text-right", edgeEnd]}>Asked</Table.Head>
</Table.Row>
{/snippet}

{#snippet subjectLabel(item: BuildListItem)}
  {#if item.subject === null}
    <span class="text-muted-foreground truncate">
      {item.build.subjectKind === "repo" ? "A removed repository" : "A removed workspace"}
    </span>
  {:else if item.subject.provider === null}
    <span class="flex min-w-0 items-center gap-1.5">
  <LayersIcon class="text-muted-foreground size-3.5 shrink-0" />
  <span class="truncate">{item.subject.name}</span>
</span>
  {:else}
    <ForgeRepoLabel repoRef={item.subject.name} provider={item.subject.provider} />
  {/if}
{/snippet}

{#snippet took(item: BuildListItem)}
  {@const ms = durations.get(item.build.id) ?? null}
  {#if ms !== null}
    {@const going = item.build.status === "building"}
    <span class="flex items-center justify-end gap-2.5">
  <span
    class="bg-muted relative h-1 w-16 shrink-0 overflow-hidden rounded-full"
    aria-hidden="true"
  >
    <span
      class={[
            "absolute inset-y-0 left-0 rounded-full",
            going
              ? "bg-primary"
              : item.build.status === "failed"
              ? "bg-destructive/70"
              : "bg-foreground/35",
          ]}
      style:width="{Math.max(4, (ms / longest) * 100)}%"
    ></span>
  </span>
  <!-- A fixed slot, so every bar starts and ends at the same place down the column. -->
  <span class={["w-14 shrink-0 text-right tabular-nums", !going && "text-muted-foreground"]}>
        {formatElapsed(ms)}
      </span>
</span>
  {:else if item.build.status === "queued"}
    <span class="text-muted-foreground">Waiting</span>
  {/if}
{/snippet}

<div class="flex flex-col gap-6">
  <PageTitle
    title="Builds"
    description="Every environment build for your repositories and workspaces, newest first."
  />

  <div class="flex flex-wrap items-center gap-2">
    <Select.Root
      type="single"
      value={data.filters.subject ?? ANY_SUBJECT}
      onValueChange={(v) => setFilter("subject", v, ANY_SUBJECT)}
    >
      <Select.Trigger class="max-w-64" aria-label="Filter by repository or workspace">
        {@const chosen = data.filters.subject === null
        ? null
        : subjectByValue.get(data.filters.subject)}
        {#if chosen?.provider}
          <ForgeRepoLabel repoRef={chosen.name} provider={chosen.provider} />
        {:else if chosen}
          <span class="truncate">{chosen.name}</span>
        {:else}
          <span class="truncate">All repositories and workspaces</span>
        {/if}
      </Select.Trigger>
      <Select.Content>
        <Select.Group>
          <Select.Item value={ANY_SUBJECT} label="All repositories and workspaces" />
        </Select.Group>
        {#if data.subjects.some((s) => s.provider !== null)}
          <Select.Group>
            <Select.Label>Repositories</Select.Label>
            {#each data.subjects.filter((s) => s.provider !== null) as subject (subject.value)}
              <Select.Item value={subject.value} label={subject.name}>
                <ForgeRepoLabel repoRef={subject.name} provider={subject.provider ?? undefined} />
              </Select.Item>
            {/each}
          </Select.Group>
        {/if}
        {#if data.subjects.some((s) => s.provider === null)}
          <Select.Group>
            <Select.Label>Workspaces</Select.Label>
            {#each data.subjects.filter((s) => s.provider === null) as subject (subject.value)}
              <Select.Item value={subject.value} label={subject.name} />
            {/each}
          </Select.Group>
        {/if}
      </Select.Content>
    </Select.Root>
    <Select.Root
      type="single"
      value={data.filters.state}
      onValueChange={(v) => setFilter("state", v, "any")}
    >
      <Select.Trigger aria-label="Filter by state">
        {STATE_LABELS[data.filters.state]}
      </Select.Trigger>
      <Select.Content>
        <Select.Group>
          {#each Object.entries(STATE_LABELS) as [value, label] (value)}
            <Select.Item {value} {label} />
          {/each}
        </Select.Group>
      </Select.Content>
    </Select.Root>
  </div>

  {#if recent.builds.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon">
          <ContainerIcon />
        </Empty.Media>
        <Empty.Title>{filtered ? "No builds match" : "Nothing has been built yet"}</Empty.Title>
        <Empty.Description>
          {#if filtered}
            Try another repository or state.
          {:else}
            A repository or workspace with a <code>.ryph/</code> directory gets an environment
            built when its default branch moves, or when an admin rebuilds it.
          {/if}
        </Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {:else}
    <PageTable {columns} {headings}>
      {#each recent.builds as item (item.build.id)}
        {@const build = item.build}
        <!-- The whole row opens the build. -->
        <Table.Row class="relative [&>td]:py-3 [&>td]:align-top">
          <Table.Cell class={edgeStart}>
            <BuildStatusBadge status={build.status} setupWarnings={build.setupWarnings} />
          </Table.Cell>
          <Table.Cell>
            <a
              href="/builds/{build.id}"
              class="flex min-w-0 flex-col gap-1 outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
            >
              <span class="flex min-w-0 items-center gap-1.5 font-medium">
                {@render subjectLabel(item)}
              </span>
              <span class="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
                <GitBranchIcon class="size-3 shrink-0" />
                <span class="truncate font-mono">{build.ref}</span>
                <span class="truncate font-mono">{builtFromLabel(build.commits)}</span>
              </span>
            </a>
          </Table.Cell>
          <Table.Cell class="whitespace-normal">
            <span class="flex flex-col gap-1">
              <span>{buildKindLabel(build.kind)}</span>
              <span class="text-muted-foreground text-xs first-letter:uppercase">
                {triggerLabel(build.trigger)}
              </span>
            </span>
          </Table.Cell>
          <Table.Cell class="text-right">{@render took(item)}</Table.Cell>
          <Table.Cell
            class={["text-muted-foreground text-right", edgeEnd]}
            title={formatDateTime(build.createdAt)}
          >
            {formatRelativeTime(build.createdAt)}
          </Table.Cell>
        </Table.Row>
      {/each}
    </PageTable>
    {#if recent.nextCursor !== null}
      <div class="flex justify-center">
        <Button variant="outline" disabled={loadingMore} onclick={loadMore}>
          {#if loadingMore}
            <Spinner data-icon="inline-start" />
          {/if}
          Load more
        </Button>
      </div>
    {/if}
  {/if}
</div>
