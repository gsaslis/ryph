<script lang="ts">
import PageTitle from "$lib/components/page-title/page-title.svelte";
import { memorySubjectKey } from "$lib/api/types";
import ForgeIcon from "$lib/components/forge-icon/forge-icon.svelte";
import { Badge } from "$lib/components/ui/badge";
import * as Card from "$lib/components/ui/card";
import * as Table from "$lib/components/ui/table";
import { formatDateTime, formatRelativeTime } from "$lib/utils/format";
import BuildingIcon from "@lucide/svelte/icons/building-2";
import type { PageProps } from "./$types";
import { subjectDisplay } from "../labels";

let { data }: PageProps = $props();

const { health } = $derived(data);
const totals = $derived(
  health.subjects.reduce(
    (acc, row) => ({
      canon: acc.canon + row.canon,
      needsVerification: acc.needsVerification + row.needsVerification,
      retired: acc.retired + row.retired,
      neverBriefed: acc.neverBriefed + row.neverBriefed,
      contested: acc.contested + row.contested,
    }),
    { canon: 0, needsVerification: 0, retired: 0, neverBriefed: 0, contested: 0 },
  ),
);
// Live is everything a brief can still draw on: the canon, and what is in it but in doubt.
const live = $derived(totals.canon + totals.needsVerification);

// Only what is actually in the inbox: "0 contradict a memory" said nothing.
const inboxDetail = $derived.by(() => {
  const parts = [
    health.inbox.contradicting > 0 && `${health.inbox.contradicting} contradict a memory`,
    health.inbox.awaiting > 0 && `${health.inbox.awaiting} waiting on a patch`,
  ].filter(Boolean);
  if (parts.length > 0) return parts.join(", ");
  return health.inbox.pending > 0 ? "Ready to review" : "All caught up";
});

const percent = (part: number, whole: number) =>
  whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;

// The subject bars share one scale — the largest subject's whole count — so a glance down the
// column compares subjects, not just the mix within each.
const largest = $derived(
  Math.max(1, ...health.subjects.map((r) => r.canon + r.needsVerification + r.retired)),
);
const width = (n: number) => `${(n / largest) * 100}%`;
</script>

<svelte:head>
  <title>Memory health · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-10">
  <PageTitle title="Health">
    {#snippet description()}
      What's in memory, what's waiting for review, and how it's set up.
    {/snippet}
  </PageTitle>

  <!-- The same card shape as the usage page: what it is, the number, a ratio in the corner, and
       two lines under it that say what the number is made of. -->
  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    <Card.Root class="@container/card from-foreground/5 to-card bg-linear-to-t shadow-xs">
      <Card.Header>
        <Card.Description class="whitespace-nowrap">Live memories</Card.Description>
        <Card.Title class="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
          {live}
        </Card.Title>
        <Card.Action>
          <Badge variant="outline">
            {totals.needsVerification > 0 ? `${totals.needsVerification} to verify` : "All verified"}
          </Badge>
        </Card.Action>
      </Card.Header>
      <Card.Footer class="flex-col items-start gap-1.5 text-sm">
        <div class="font-medium">
          Across {health.subjects.length}
          {health.subjects.length === 1 ? "subject" : "subjects"}
        </div>
        <div class="text-muted-foreground">
          {totals.contested} contested, {totals.retired} retired
        </div>
      </Card.Footer>
    </Card.Root>

    <Card.Root class="@container/card from-foreground/5 to-card bg-linear-to-t shadow-xs">
      <Card.Header>
        <Card.Description class="whitespace-nowrap">Never briefed</Card.Description>
        <Card.Title class="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
          {totals.neverBriefed}
        </Card.Title>
        <Card.Action>
          <Badge variant="outline">{percent(totals.neverBriefed, live)} of live</Badge>
        </Card.Action>
      </Card.Header>
      <Card.Footer class="flex-col items-start gap-1.5 text-sm">
        <div class="font-medium">Not in any brief yet</div>
        <div class="text-muted-foreground">New, or ranked too low</div>
      </Card.Footer>
    </Card.Root>

    <Card.Root class="@container/card from-foreground/5 to-card bg-linear-to-t shadow-xs">
      <Card.Header>
        <Card.Description class="whitespace-nowrap">Inbox</Card.Description>
        <Card.Title class="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
          <a href="/memory" class="hover:underline hover:underline-offset-4">
            {health.inbox.pending}
          </a>
        </Card.Title>
        <Card.Action>
          <Badge variant={health.inbox.flagged > 0 ? "destructive" : "outline"}>
            {health.inbox.flagged} flagged
          </Badge>
        </Card.Action>
      </Card.Header>
      <Card.Footer class="flex-col items-start gap-1.5 text-sm">
        <div class="font-medium">
          {#if health.inbox.oldestAt}
            <span title={formatDateTime(health.inbox.oldestAt)}>
              Oldest waiting since {formatRelativeTime(health.inbox.oldestAt)}
            </span>
          {:else}
            Nothing waiting
          {/if}
        </div>
        <div class="text-muted-foreground">
          {inboxDetail}
        </div>
      </Card.Footer>
    </Card.Root>
  </div>

  <section class="flex min-w-0 flex-col gap-3">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div class="flex flex-col gap-1">
        <h2 class="text-base font-medium">By subject</h2>
        <p class="text-muted-foreground text-sm">
          What each repository, and the org as a whole, holds.
        </p>
      </div>
      <!-- The bar's key, once, rather than per row. -->
      <div class="text-muted-foreground flex items-center gap-3 text-xs">
        <span
          class="flex items-center gap-1.5"><span class="bg-primary size-2 rounded-full"></span>Canon</span>
        <span
          class="flex items-center gap-1.5"><span class="bg-warning size-2 rounded-full"></span>To verify</span>
        <span class="flex items-center gap-1.5">
          <span class="bg-muted-foreground/30 size-2 rounded-full"></span>Retired
        </span>
      </div>
    </div>
    <Table.Root class="bg-background">
      <Table.Header>
        <Table.Row>
          <Table.Head>Subject</Table.Head>
          <Table.Head class="w-1/4"><span class="sr-only">Mix</span></Table.Head>
          <Table.Head class="text-right">Canon</Table.Head>
          <Table.Head class="text-right">To verify</Table.Head>
          <Table.Head class="text-right">Retired</Table.Head>
          <Table.Head class="text-right">Never briefed</Table.Head>
          <Table.Head class="text-right">Contested</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each health.subjects as row (memorySubjectKey(row.subject))}
          {@const shown = subjectDisplay(row.subject)}
          <Table.Row class="h-12 tabular-nums">
            <Table.Cell>
              <a
                href="/memory?subject={encodeURIComponent(memorySubjectKey(row.subject))}"
                class="flex items-center gap-2 underline-offset-4 hover:underline"
                title={shown.full}
              >
                {#if shown.provider}
                  <ForgeIcon provider={shown.provider} />
                {:else}
                  <BuildingIcon class="size-4 shrink-0" />
                {/if}
                {shown.label}
              </a>
            </Table.Cell>
            <Table.Cell>
              <div
                class="bg-muted flex h-1.5 overflow-hidden rounded-full"
                title="{row.canon} canon, {row.needsVerification} to verify, {row.retired} retired"
              >
                <div class="bg-primary" style:width={width(row.canon)}></div>
                <div class="bg-warning" style:width={width(row.needsVerification)}></div>
                <div class="bg-muted-foreground/30" style:width={width(row.retired)}></div>
              </div>
            </Table.Cell>
            <Table.Cell class="text-right">{row.canon}</Table.Cell>
            <Table.Cell class={["text-right", row.needsVerification === 0 && "text-muted-foreground"]}>
              {row.needsVerification}
            </Table.Cell>
            <Table.Cell class="text-muted-foreground text-right">{row.retired}</Table.Cell>
            <Table.Cell class={["text-right", row.neverBriefed === 0 && "text-muted-foreground"]}>
              {row.neverBriefed}
            </Table.Cell>
            <Table.Cell class={["text-right", row.contested === 0 && "text-muted-foreground"]}>
              {row.contested}
            </Table.Cell>
          </Table.Row>
        {:else}
          <Table.Row>
            <Table.Cell colspan={7} class="text-muted-foreground h-24 text-center">
              Nothing remembered yet.
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </section>
  <!-- How memory is set up, not what it holds, so apart from the numbers above. Two separate
       things that are easy to run together: the consolidator is a call to an external model
       through platform model access; search runs on a self-hosted embedding model. Either can be
       on without the other. -->
  <section class="flex min-w-0 flex-col gap-3">
    <div class="flex flex-col gap-1">
      <h2 class="text-base font-medium">Setup</h2>
      <p class="text-muted-foreground text-sm">What this deployment gives memory to work with.</p>
    </div>
    <div class="grid gap-4 sm:grid-cols-2">
      <Card.Root class="@container/card from-foreground/5 to-card bg-linear-to-t shadow-xs">
        <Card.Header>
          <Card.Description>Consolidator</Card.Description>
          <Card.Title class="text-xl font-semibold">
            {health.modelBacked ? "Model-backed" : "Rules only"}
          </Card.Title>
          <Card.Action>
            <Badge variant="outline">{health.modelBacked ? "Platform model" : "No model"}</Badge>
          </Card.Action>
        </Card.Header>
        <Card.Footer class="flex-col items-start gap-1.5 text-sm">
          <div class="font-medium">
            {health.modelBacked
              ? "Catches contradictions and tightens claims"
              : "Screens proposals and removes exact duplicates"}
          </div>
          <div class="text-muted-foreground">
            {#if health.modelBacked}
              Using the platform's model access.
            {:else}
              Set up
              <a href="/instance/platform#background-model" class="underline underline-offset-4">a background model</a>
              to have it judge contradictions too.
            {/if}
          </div>
        </Card.Footer>
      </Card.Root>
      <Card.Root class="@container/card from-foreground/5 to-card bg-linear-to-t shadow-xs">
        <Card.Header>
          <Card.Description>Search</Card.Description>
          <Card.Title class="text-xl font-semibold">
            {health.embeddings ? "Semantic and keyword" : "Keyword only"}
          </Card.Title>
          <Card.Action>
            {#if health.embeddings && health.embeddings.pending > 0}
              <Badge variant="outline">{health.embeddings.pending} pending</Badge>
            {:else if health.embeddings}
              <Badge variant="outline">Up to date</Badge>
            {:else}
              <Badge variant="outline">No embeddings</Badge>
            {/if}
          </Card.Action>
        </Card.Header>
        <Card.Footer class="flex-col items-start gap-1.5 text-sm">
          {#if health.embeddings}
            <div class="font-medium">{health.embeddings.embedded} memories embedded</div>
            <div class="text-muted-foreground">
              With <span class="font-mono text-xs">{health.embeddings.model}</span>, running on
              this deployment.
            </div>
          {:else}
            <div class="font-medium">Matches words, not meaning</div>
            <div class="text-muted-foreground">
              This deployment runs no embedding model.
            </div>
          {/if}
        </Card.Footer>
      </Card.Root>
    </div>
  </section>
</div>
