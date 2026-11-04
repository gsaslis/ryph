<script lang="ts">
import PageTable, { edgeEnd, edgeStart } from "$lib/components/page-table/page-table.svelte";
import PageTitle from "$lib/components/page-title/page-title.svelte";
import { goto } from "$app/navigation";
import { getPatches } from "$lib/api/patches";
import { isPatchAdvancing } from "$lib/api/types";
import { appendPatchPage, type DeeperPatches, mergePatchHead } from "./patch-queue";
import PatchActions from "$lib/components/patch-actions/patch-actions.svelte";
import PatchStateBadge from "$lib/components/patch-state-badge/patch-state-badge.svelte";
import LandedBadge from "$lib/components/patch-state-badge/landed-badge.svelte";
import CheckStateBadge from "$lib/components/check-state-badge/check-state-badge.svelte";
import { shortCommit } from "$lib/utils/environments";
import { countsLabel, isSuiteSettled } from "$lib/utils/checks";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Empty from "$lib/components/ui/empty";
import * as Select from "$lib/components/ui/select";
import { Spinner } from "$lib/components/ui/spinner";
import * as Table from "$lib/components/ui/table";
import { formatDateTime, formatRelativeTime } from "$lib/utils/format";
import { refreshWhileLive } from "$lib/utils/live-refresh.svelte.js";
import ForgeRepoLabel from "$lib/components/forge-repo-label/forge-repo-label.svelte";
import GitBranchIcon from "@lucide/svelte/icons/git-branch";
import GitPullRequestIcon from "@lucide/svelte/icons/git-pull-request";
import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import {
  HOOK_BADGE_LABEL,
  HOOK_CHECK_FAILED_LABEL,
  HOOK_CHECKING_LABEL,
  hookCheckNotice,
  isCheckingHooks,
  isHeld,
} from "$lib/utils/hook-check";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

// The queue as it is on screen: the load's page merged with whatever "Load more" has appended
// beneath it (patch-queue.ts). Keyed on the STATE FILTER and not on the head array's identity —
// the five-second poller re-runs the load, which hands over a new array every time, and an
// identity check read that as "a different queue" and threw away every page the reader had
// asked for. Derived rather than synced in an effect, so the server renders it too.
let deeper = $state<DeeperPatches | null>(null);
const held = $derived(deeper !== null && deeper.key === data.state ? deeper : null);
const merged = $derived(
  mergePatchHead(held, { patches: data.patches, nextCursor: data.nextCursor }),
);
const patches = $derived(merged.rows);
const cursor = $derived(merged.cursor);

let loadingMore = $state(false);
async function loadMore() {
  if (cursor === null || loadingMore) return;
  loadingMore = true;
  const key = data.state;
  try {
    const page = await getPatches(fetch, key === "all" ? undefined : key, { cursor });
    // The filter changed while this was in flight: these rows answer a question nobody is asking.
    if (key !== data.state) return;
    deeper = appendPatchPage(held, key, data.patches, page);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to load more patches");
  } finally {
    loadingMore = false;
  }
}

// A patch's checks run on their own too, and an approver waiting on them should see them land.
// Only the head re-reads, so only its rows can settle: a "Load more" row still moving would keep
// the poll going for nothing.
refreshWhileLive(
  "app:patches",
  () =>
    data.patches.some((p) =>
      isPatchAdvancing(p) || p.hooksPending ||
      (p.checks !== null && !isSuiteSettled(p.checks.state))
    ),
);

const stateFilters = [
  { value: "all", label: "All states" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "queued", label: "Queued" },
  { value: "submitting", label: "Submitting" },
  { value: "submitted", label: "Submitted" },
  { value: "failed", label: "Failed" },
  { value: "rejected", label: "Rejected" },
  { value: "superseded", label: "Superseded" },
] as const;

const filterLabel = $derived(
  stateFilters.find((f) => f.value === data.state)?.label ?? "All states",
);

async function changeFilter(state: string) {
  await goto(state === "all" ? "/patches" : `/patches?state=${encodeURIComponent(state)}`, {
    keepFocus: true,
  });
}

// A set is every patch born from one run: a change that spanned repos shows its parts side by
// side, and each part says how many siblings it has — they land independently.
const setSizes = $derived.by(() => {
  const sizes = new Map<string, number>();
  for (const patch of patches) sizes.set(patch.setId, (sizes.get(patch.setId) ?? 0) + 1);
  return sizes;
});
</script>

<svelte:head>
  <title>Patches · Ryph</title>
</svelte:head>

{#snippet columns()}
  <colgroup>
  <col class="w-[calc(--spacing(40)_+_var(--side))]" />
  <col />
  <col class="w-[16%]" />
  <col class="w-[13%]" />
  <col class="w-28" />
  <col class="w-[calc(--spacing(56)_+_var(--side))]" />
</colgroup>
{/snippet}

{#snippet headings()}
  <Table.Row class="bg-muted/40 hover:bg-muted/40">
  <Table.Head class={edgeStart}>State</Table.Head>
  <Table.Head>Change</Table.Head>
  <Table.Head>Checks</Table.Head>
  <Table.Head>Agent</Table.Head>
  <Table.Head class="text-right">Created</Table.Head>
  <Table.Head class={["text-right", edgeEnd]}><span class="sr-only">Actions</span></Table.Head>
</Table.Row>
{/snippet}


<div class="flex flex-col gap-6">
  <PageTitle
    title="Patches"
    description="Changes agents made, on their way to your forge. Approve one to send it there."
  />

  <div class="flex flex-wrap items-center gap-2">
    <Select.Root type="single" value={data.state} onValueChange={changeFilter}>
      <Select.Trigger aria-label="Filter by state">
        {filterLabel}
      </Select.Trigger>
      <Select.Content>
        <Select.Group>
          {#each stateFilters as filter (filter.value)}
            <Select.Item value={filter.value} label={filter.label} />
          {/each}
        </Select.Group>
      </Select.Content>
    </Select.Root>
  </div>

  {#if patches.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon">
          <GitPullRequestIcon />
        </Empty.Media>
        <Empty.Title>
          {data.state === "pending_approval"
            ? "Nothing waiting for approval"
            : data.state === "all"
            ? "No patches yet"
            : "No patches here"}
        </Empty.Title>
        <Empty.Description>
          {data.state === "pending_approval"
            ? "When an agent finishes work on a repo that requires approval, its patch lands here for review."
            : data.state === "all"
            ? "When an agent finishes work on a repo, its patch shows up here."
            : "No patches match this filter."}
        </Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {:else}
    <PageTable {columns} {headings}>
      {#each patches as patch (patch.id)}
        {@const setSize = setSizes.get(patch.setId) ?? 1}
        <!-- The whole row opens the patch; the links and buttons inside it sit above that. -->
        <Table.Row class="relative [&>td]:py-3 [&>td]:align-top">
          <Table.Cell class={edgeStart}>
            <span class="flex flex-col items-start gap-1">
              <PatchStateBadge state={patch.state} held={patch.heldReason} />
              {#if patch.landed}
                <LandedBadge landed={patch.landed} />
              {/if}
              {#if isHeld(patch)}
                <Badge variant="destructive">
                  <TriangleAlertIcon />
                  {HOOK_BADGE_LABEL}
                </Badge>
              {:else if isCheckingHooks(patch)}
                <span class="text-muted-foreground flex items-center gap-1 text-xs">
                  <Spinner class="size-3" />
                  {HOOK_CHECKING_LABEL}
                </span>
              {:else if hookCheckNotice(patch)}
                <span
                  class="text-muted-foreground flex items-center gap-1 text-xs"
                  title={hookCheckNotice(patch)}
                >
                  <CircleAlertIcon class="size-3" />
                  {HOOK_CHECK_FAILED_LABEL}
                </span>
              {/if}
            </span>
          </Table.Cell>
          <Table.Cell class="whitespace-normal">
            <span class="flex min-w-0 flex-col gap-1">
              <a
                href="/patches/{patch.id}"
                class="truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
              >
                {patch.title ?? patch.taskTitle ?? patch.branchName}
              </a>
              <span class="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
                <ForgeRepoLabel
                  repoRef={patch.repoRef}
                  provider={patch.provider ?? undefined}
                  fallback={patch.connectedRepoId}
                />
                <GitBranchIcon class="ml-1 size-3 shrink-0" />
                <span class="truncate font-mono">{patch.branchName}</span>
                <span class="shrink-0 font-mono">{shortCommit(patch.headSha)}</span>
                <span class="shrink-0">
                  · {patch.commits.length} {patch.commits.length === 1 ? "commit" : "commits"}
                </span>
                {#if setSize > 1}
                  <span
                    class="shrink-0"
                    title="Part of a change across repositories. Each part lands on its own."
                  >
                    · 1 of {setSize} repos
                  </span>
                {/if}
              </span>
              {#if patch.state === "failed" && patch.lastError}
                <span class="text-destructive line-clamp-2 text-xs">{patch.lastError}</span>
              {/if}
            </span>
          </Table.Cell>
          <Table.Cell>
            {#if patch.checks}
              <a
                href="/checks/{patch.checks.suiteId}"
                class="relative z-10 inline-flex max-w-full flex-col items-start gap-1 underline-offset-4 hover:underline"
              >
                <CheckStateBadge state={patch.checks.state} />
                <span class="text-muted-foreground text-xs">{countsLabel(patch.checks)}</span>
              </a>
            {/if}
          </Table.Cell>
          <Table.Cell class="text-muted-foreground truncate">
            {patch.agentName ?? ""}
          </Table.Cell>
          <Table.Cell
            class="text-muted-foreground text-right"
            title={formatDateTime(patch.createdAt)}
          >
            {formatRelativeTime(patch.createdAt)}
          </Table.Cell>
          <Table.Cell class={edgeEnd}>
            <span class="relative z-10 flex items-center justify-end gap-1.5">
              <PatchActions {patch} refresh="app:patches" />
            </span>
          </Table.Cell>
        </Table.Row>
      {/each}
    </PageTable>

    {#if cursor !== null}
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
