<script lang="ts">
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { listCheckSuites } from "$lib/api/checks";
import type { CheckSuiteListItem } from "$lib/api/types";
import CheckStateBadge from "$lib/components/check-state-badge/check-state-badge.svelte";
import CheckStateIcon from "$lib/components/check-state-icon/check-state-icon.svelte";
import ForgeIcon from "$lib/components/forge-icon/forge-icon.svelte";
import ForgeRepoLabel from "$lib/components/forge-repo-label/forge-repo-label.svelte";
import { providerOfRepoRef } from "$lib/utils/forge";
import PageTable, { edgeEnd, edgeStart } from "$lib/components/page-table/page-table.svelte";
import PageTitle from "$lib/components/page-title/page-title.svelte";
import { Button } from "$lib/components/ui/button";
import * as Empty from "$lib/components/ui/empty";
import * as Select from "$lib/components/ui/select";
import { Spinner } from "$lib/components/ui/spinner";
import * as Table from "$lib/components/ui/table";
import * as Tooltip from "$lib/components/ui/tooltip";
import {
  checkDurationMs,
  checkStateLabel,
  isSuiteSettled,
  progressLabel,
  suiteDurationMs,
} from "$lib/utils/checks";
import { can } from "$lib/utils/auth/capabilities";
import { shortCommit } from "$lib/utils/environments";
import { formatDateTime, formatElapsed, formatRelativeTime } from "$lib/utils/format";
import { liveClock } from "$lib/utils/live-clock.svelte";
import { refreshWhileLive } from "$lib/utils/live-refresh.svelte.js";
import CircleCheckBigIcon from "@lucide/svelte/icons/circle-check-big";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import GitBranchIcon from "@lucide/svelte/icons/git-branch";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";
import type { AskerFilter, StateFilter } from "./filters";
import { appendSuitePage, type DeeperSuites, mergeSuiteHead } from "./recent";

let { data }: PageProps = $props();

const STATE_LABELS: Record<StateFilter, string> = {
  any: "Any state",
  failing: "Failing",
  passed: "Passed",
  active: "Running or waiting",
};
const ASKER_LABELS: Record<AskerFilter, string> = {
  anyone: "Asked by anyone",
  tool: "Asked by an agent",
  patch: "Asked by a patch",
  push: "Asked by a push",
  forge: "Run again by hand",
  local: "Asked locally",
};
const ANY_REPO = "all";

// A suite only a push or a person's own commit asked for names no task: it is shown to those who
// read every task, to its asker, and to anyone who may push to its repo. Those filters are theirs.
const seesTasklessSuites = $derived(
  can(data.user, "tasks:read-all") || can(data.user, "checks:request"),
);
const askerOptions = $derived(
  Object.entries(ASKER_LABELS).filter(
    ([value]) => (value !== "push" && value !== "local") || seesTasklessSuites,
  ),
);
const repoById = $derived(new Map(data.repos.map((r) => [r.connectedRepoId, r])));
const multiForge = $derived(new Set(data.repos.map((r) => r.provider)).size > 1);

/** Narrows the list: the filter lands in the address, and the load reads it from there. */
function setFilter(key: "repo" | "state" | "asked", value: string, fallback: string) {
  const url = new URL(page.url);
  if (value === fallback) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  void goto(url, { keepFocus: true, noScroll: true, replaceState: true });
}

const filtered = $derived(
  data.filters.repo !== null || data.filters.state !== "any" || data.filters.asker !== "anyone",
);

// The list as it is on screen: the load's page and whatever "Load more" appended beneath it
// (recent.ts), held per filter so the poll below keeps the pages the reader asked for.
const filterKey = $derived(
  `${data.filters.repo ?? ""}|${data.filters.state}|${data.filters.asker}`,
);
let deeper = $state<DeeperSuites | null>(null);
const held = $derived(deeper !== null && deeper.key === filterKey ? deeper : null);
const recent = $derived(mergeSuiteHead(held, { suites: data.suites, nextCursor: data.nextCursor }));

const clock = liveClock(() => recent.suites.some((item) => item.suite.state === "running"));

let loadingMore = $state(false);
async function loadMore() {
  const cursor = recent.nextCursor;
  if (cursor === null || loadingMore) return;
  loadingMore = true;
  const key = filterKey;
  const { repo, state, asker } = data.filters;
  try {
    const page = await listCheckSuites(fetch, { repo, state, asked: asker }, { cursor });
    // The filters changed while this was in flight: these rows answer another list.
    if (key !== filterKey) return;
    deeper = appendSuitePage(held, key, data.suites, page);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to load more checks");
  } finally {
    loadingMore = false;
  }
}

// Only the head re-reads, so only its rows can settle: a "Load more" row still running would
// keep the poll going for nothing. Anything running anywhere keeps it going too, since a suite
// that starts lands at the head.
refreshWhileLive(
  "app:checks",
  () => data.activeCount > 0 || data.suites.some((item) => !isSuiteSettled(item.suite.state)),
);
</script>

<svelte:head>
  <title>Checks · Ryph</title>
</svelte:head>

<!-- One check of a suite, as a small icon: a suite's checks side by side, so the one that failed
     stands out down the column. Raised above the row's link so each can be hovered for its name. -->
{#snippet strip(item: CheckSuiteListItem)}
  <span class="relative z-10 flex flex-wrap items-center gap-1">
    {#each item.suite.checks as check (check.name)}
      {@const took = checkDurationMs(check, clock.now)}
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <span {...props} class="flex">
              <CheckStateIcon state={check.state} />
            </span>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>
          <span class="font-mono">{check.name}</span>
          <span class="opacity-70">
            {checkStateLabel(check.state)}{took === null ? "" : `, ${formatElapsed(took)}`}
          </span>
        </Tooltip.Content>
      </Tooltip.Root>
    {/each}
  </span>
{/snippet}

{#snippet columns()}
  <!-- Share the content width, not the full-bleed table: its wide-screen margins are
       already reserved by the outer columns and would otherwise squeeze Repository out.
       Match PageTable's 64rem minimum and gutters in lengths: a percentage/length calc
       on a fixed-layout table column is treated as auto by browsers. -->
  <colgroup
  class="[--content-width:calc(max(64rem,100cqw_+_2_*_var(--page-gutter))_-_2_*_var(--side))]"
>
  <col class="w-[calc(--spacing(36)_+_var(--side))]" />
  <col />
  <col class="w-[calc(var(--content-width)_*_0.16)]" />
  <col class="w-[calc(var(--content-width)_*_0.26)]" />
  <col class="w-28" />
  <col class="w-[calc(--spacing(28)_+_var(--side))]" />
</colgroup>
{/snippet}

{#snippet headings()}
  <Table.Row class="bg-muted/40 hover:bg-muted/40">
  <Table.Head class={edgeStart}>State</Table.Head>
  <Table.Head>Repository</Table.Head>
  <Table.Head>Checks</Table.Head>
  <Table.Head>Asked by</Table.Head>
  <Table.Head class="text-right">Took</Table.Head>
  <Table.Head class={["text-right", edgeEnd]}>Started</Table.Head>
</Table.Row>
{/snippet}

{#snippet askers(item: CheckSuiteListItem)}
  <span class="flex min-w-0 flex-col gap-0.5">
    {#each item.askedBy as asker, i (i)}
      {#if asker.href === null}
        <span class="text-muted-foreground truncate">{asker.label}</span>
      {:else}
        {@const external = asker.href.startsWith("http")}
        <a
          href={asker.href}
          target={external ? "_blank" : undefined}
          rel={external ? "noreferrer" : undefined}
          class="relative z-10 inline-flex max-w-full items-center gap-1 underline-offset-4 hover:underline"
        >
          <span class="truncate">{asker.label}</span>
          {#if external}
            <ExternalLinkIcon class="text-muted-foreground size-3 shrink-0" />
          {/if}
        </a>
      {/if}
    {/each}
  </span>
{/snippet}

<div class="flex flex-col gap-6">
  <PageTitle title="Checks" description="Every check run against your repositories, newest first." />

  <div class="flex flex-wrap items-center gap-2">
    <Select.Root
      type="single"
      value={data.filters.repo ?? ANY_REPO}
      onValueChange={(v) => setFilter("repo", v, ANY_REPO)}
    >
      <Select.Trigger class="max-w-64" aria-label="Filter by repository">
        {@const chosen = data.filters.repo === null ? null : repoById.get(data.filters.repo)}
        {#if chosen}
          <ForgeRepoLabel repoRef={chosen.repoRef} provider={chosen.provider} />
        {:else}
          <span class="truncate">{data.filters.repo ?? "All repositories"}</span>
        {/if}
      </Select.Trigger>
      <Select.Content>
        <Select.Group>
          <Select.Item value={ANY_REPO} label="All repositories" />
          {#each data.repos as repo (repo.connectedRepoId)}
            <Select.Item value={repo.connectedRepoId} label={repo.repoRef}>
              <ForgeRepoLabel repoRef={repo.repoRef} provider={repo.provider} />
            </Select.Item>
          {/each}
        </Select.Group>
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
    <Select.Root
      type="single"
      value={data.filters.asker}
      onValueChange={(v) => setFilter("asked", v, "anyone")}
    >
      <Select.Trigger aria-label="Filter by who asked">
        {ASKER_LABELS[data.filters.asker]}
      </Select.Trigger>
      <Select.Content>
        <Select.Group>
          {#each askerOptions as [value, label] (value)}
            <Select.Item {value} {label} />
          {/each}
        </Select.Group>
      </Select.Content>
    </Select.Root>
    {#if data.capacity.inUse > 0}
      <span class="text-muted-foreground ml-auto flex items-center gap-2 text-sm tabular-nums">
        <Spinner class="text-primary" />
        {data.capacity.inUse} of {data.capacity.total} check pods in use
      </span>
    {/if}
  </div>

  {#if recent.suites.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon">
          <CircleCheckBigIcon />
        </Empty.Media>
        <Empty.Title>{filtered ? "No checks match" : "No checks have run yet"}</Empty.Title>
        <Empty.Description>
          {#if filtered}
            Try another repository or state.
          {:else}
            Checks run on repositories with a <code>.ryph/checks.yml</code>, when an agent asks
            for them or a change is pushed for review.
          {/if}
        </Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {:else}
    <PageTable {columns} {headings}>
      {#each recent.suites as item (item.suite.id)}
        {@const suite = item.suite}
        {@const took = suiteDurationMs(suite, clock.now)}
        {@const repo = repoById.get(suite.connectedRepoId)}
        <!-- Carried, never sniffed: only a suite with neither a repo row nor a provider of its own
             is read off its address, which never answers GitLab. -->
        {@const suiteProvider = repo?.provider ?? suite.provider ??
          (suite.repoRef ? providerOfRepoRef(suite.repoRef) : null)}
        {@const notes = [
          suite.partial && "Some of the checks",
          suite.generation > 1 && `Run ${suite.generation}`,
        ].filter(Boolean).join(", ")}
        <!-- The whole row opens the suite; the links inside it sit above that. -->
        <Table.Row class="relative [&>td]:py-3 [&>td]:align-top">
          <Table.Cell class={edgeStart}>
            <CheckStateBadge state={suite.state} />
          </Table.Cell>
          <Table.Cell>
            <a
              href="/checks/{suite.id}"
              class="flex min-w-0 flex-col gap-1 outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
            >
              <span class="flex min-w-0 items-center gap-1.5 font-medium">
                {#if multiForge && suiteProvider}
                  <ForgeIcon
                    provider={suiteProvider}
                    class="text-muted-foreground size-3.5 shrink-0"
                  />
                {/if}
                <ForgeRepoLabel repoRef={suite.repoRef} provider={suiteProvider ?? undefined} />
              </span>
              <span class="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
                <GitBranchIcon class="size-3 shrink-0" />
                {#if item.branch}
                  <span class="truncate font-mono">{item.branch}</span>
                {/if}
                <span class="shrink-0 font-mono">{shortCommit(suite.commit)}</span>
              </span>
            </a>
          </Table.Cell>
          <Table.Cell class="whitespace-normal">
            <span class="flex flex-col gap-1.5">
              {#if suite.state === "waiting"}
                <span class="text-muted-foreground">
                  {suite.environment.environmentId
                    ? "Waiting for its environment build"
                    : "Waiting for its environment"}
                </span>
              {:else if suite.state === "queued"}
                <span class="text-muted-foreground">Waiting for a free pod</span>
              {:else}
                {@render strip(item)}
              {/if}
              {#if notes !== ""}
                <span class="text-muted-foreground text-xs">{notes}</span>
              {/if}
            </span>
          </Table.Cell>
          <Table.Cell class="whitespace-normal">{@render askers(item)}</Table.Cell>
          <Table.Cell class="text-muted-foreground text-right tabular-nums">
            {#if took !== null}
              {formatElapsed(took)}
            {:else if suite.state === "running"}
              {progressLabel(suite)}
            {/if}
          </Table.Cell>
          <Table.Cell
            class={["text-muted-foreground text-right", edgeEnd]}
            title={formatDateTime(suite.createdAt)}
          >
            {formatRelativeTime(suite.createdAt)}
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
