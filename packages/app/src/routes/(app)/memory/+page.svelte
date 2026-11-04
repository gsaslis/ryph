<script lang="ts">
import { can } from "$lib/utils/auth/capabilities";
import { page } from "$app/state";
import PageTitle from "$lib/components/page-title/page-title.svelte";
import { goto, invalidate } from "$app/navigation";
import {
  acceptMemoryProposal,
  consolidateMemory,
  createMemory,
  getMemories,
  rejectMemoryProposal,
  resolveMemoryProposals,
} from "$lib/api/memory";
import {
  type Memory,
  type MemoryKind,
  memoryKindSchema,
  type MemoryProposal,
  memoryStatusSchema,
  type MemorySubject,
  memorySubjectKey,
  memoryTrustSchema,
} from "$lib/api/types";
import { SubjectPicker } from "$lib/components/subject-picker";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Checkbox } from "$lib/components/ui/checkbox";
import * as Dialog from "$lib/components/ui/dialog";
import * as Empty from "$lib/components/ui/empty";
import * as Field from "$lib/components/ui/field";
import * as InputGroup from "$lib/components/ui/input-group";
import { Label } from "$lib/components/ui/label";
import * as Select from "$lib/components/ui/select";
import { Spinner } from "$lib/components/ui/spinner";
import * as Tabs from "$lib/components/ui/tabs";
import { Textarea } from "$lib/components/ui/textarea";
import AgentAvatar from "$lib/components/agent-avatar/agent-avatar.svelte";
import ForgeIcon from "$lib/components/forge-icon/forge-icon.svelte";
import BuildingIcon from "@lucide/svelte/icons/building-2";
import PencilIcon from "@lucide/svelte/icons/pencil";
import PinIcon from "@lucide/svelte/icons/pin";
import ThumbsDownIcon from "@lucide/svelte/icons/thumbs-down";
import ThumbsUpIcon from "@lucide/svelte/icons/thumbs-up";
import BrainIcon from "@lucide/svelte/icons/brain";
import CheckIcon from "@lucide/svelte/icons/check";
import InboxIcon from "@lucide/svelte/icons/inbox";
import LockIcon from "@lucide/svelte/icons/lock";
import PlusIcon from "@lucide/svelte/icons/plus";
import SearchIcon from "@lucide/svelte/icons/search";
import SparklesIcon from "@lucide/svelte/icons/sparkles";
import XIcon from "@lucide/svelte/icons/x";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";
import { type BrowseFilters, filtersToSearch, joinPages, splitPage, toApiFilters } from "./filters";
import { KIND_LABEL, STATUS_LABEL, subjectDisplay, TRUST_LABEL } from "./labels";

let { data }: PageProps = $props();

const canManage = $derived(can(data.user, "memory:manage"));

// ── filters ─────────────────────────────────────────────────────────────────────────────────

// The form's own copy of the URL's filters: typed into, then pushed back as a navigation so a
// filtered view stays a link. `keepFocus` so the search box does not lose the cursor mid-word.
// Seeded once from the load and re-seeded by the effect below on every navigation.
// svelte-ignore state_referenced_locally
let filters = $state<BrowseFilters>({ ...data.filters });
$effect(() => {
  filters = { ...data.filters };
});

async function applyFilters() {
  await goto(`/memory${filtersToSearch(filters)}`, { keepFocus: true });
}

function onSearch(event: SubmitEvent) {
  event.preventDefault();
  void applyFilters();
}

const ANY = "__any";
const setFilter = (key: keyof BrowseFilters) => (value: string | undefined) => {
  filters = { ...filters, [key]: !value || value === ANY ? "" : value } as BrowseFilters;
  void applyFilters();
};

// The subjects the index knows, for the subject filter: the org, then every repo, each with how
// many live memories it holds.
const subjectOptions = $derived.by(() => {
  const totals = new Map<string, { label: string; count: number }>();
  for (const row of data.subjects) {
    if (row.status === "retired") continue;
    const key = memorySubjectKey(row.subject);
    const label = row.subject.kind === "org" ? "the org" : row.subject.url;
    const entry = totals.get(key) ?? { label, count: 0 };
    entry.count += row.count;
    totals.set(key, entry);
  }
  return [...totals.entries()]
    .map(([key, { label, count }]) => ({ key, label, count }))
    .sort((a, b) => (a.key === "org" ? -1 : b.key === "org" ? 1 : a.label.localeCompare(b.label)));
});

const agentName = $derived(new Map(data.agents.map((a) => [a.id, a.name])));

const activeFilters = $derived(
  [filters.subject, filters.kind, filters.status, filters.trust, filters.q].filter(Boolean).length,
);

function clearFilters() {
  filters = { subject: "", audience: "", kind: "", status: "", trust: "", q: "" };
  void applyFilters();
}

// ── more pages ──────────────────────────────────────────────────────────────────────────────

// The load reads the first page; "Show more" appends the next ones here. Every new load — a
// filter change, an invalidate after a write — starts the list over at its first page.
let morePages = $state<Memory[][]>([]);
// svelte-ignore state_referenced_locally
let hasMore = $state(data.hasMore);
let loadingMore = $state(false);
$effect(() => {
  const fresh = data;
  morePages = [];
  hasMore = fresh.hasMore;
  loadingMore = false;
});

const memories = $derived(joinPages([data.memories, ...morePages]));

async function showMore() {
  const from = data;
  // The offset counts rows as the service sent them, before joinPages drops a repeat.
  const offset = from.memories.length + morePages.reduce((n, page) => n + page.length, 0);
  loadingMore = true;
  try {
    const page = splitPage(await getMemories(fetch, toApiFilters(from.filters, offset)));
    // A navigation while this page was in flight started a different list; drop it.
    if (data !== from) return;
    morePages = [...morePages, page.memories];
    hasMore = page.hasMore;
  } catch (e) {
    if (data === from) toast.error(e instanceof Error ? e.message : "Failed to load more memories");
  } finally {
    if (data === from) loadingMore = false;
  }
}

// ── write a memory by hand ──────────────────────────────────────────────────────────────────

let writeOpen = $state(false);
let writeText = $state("");
let writeKind = $state<MemoryKind>("fact");
let writeSubject = $state("org");
let writeRepoUrl = $state("");
let writePinned = $state(false);
let writing = $state(false);

function openWrite() {
  writeText = "";
  writeKind = "fact";
  writeSubject = filters.subject.startsWith("repo:") ? "repo" : "org";
  writeRepoUrl = filters.subject.startsWith("repo:") ? filters.subject.slice("repo:".length) : "";
  writePinned = false;
  writeOpen = true;
}

async function submitWrite(event: SubmitEvent) {
  event.preventDefault();
  writing = true;
  try {
    const memory = await createMemory(fetch, {
      text: writeText,
      kind: writeKind,
      subject: writeSubject === "repo" ? { kind: "repo", url: writeRepoUrl } : { kind: "org" },
      pinned: writePinned,
    });
    toast.success(`Recorded ${memory.id}`);
    writeOpen = false;
    await invalidate("app:memory");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to record the memory");
  } finally {
    writing = false;
  }
}

const repoSuggestions = (
  subjects: { subject: { kind: string; url?: string } }[],
) => [
  ...new Set(
    subjects.flatMap((s) => (s.subject.kind === "repo" && s.subject.url ? [s.subject.url] : [])),
  ),
];

// ── the inbox ───────────────────────────────────────────────────────────────────────────────

let busyProposal: string | null = $state(null);
let consolidating = $state(false);

async function accept(proposal: MemoryProposal) {
  busyProposal = proposal.id;
  try {
    const memory = await acceptMemoryProposal(fetch, proposal.id);
    toast.success(`Promoted as ${memory.id}`);
    await invalidate("app:memory");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to accept the proposal");
  } finally {
    busyProposal = null;
  }
}

// Edit, then accept: a proposal whose claim, kind or subject is nearly right — an agent that
// guessed the org for what is about one repository — is corrected on its way into the canon.
const knownRepos = $derived(repoSuggestions(data.subjects));
let editOpen = $state(false);
let editing = $state<MemoryProposal | null>(null);
let editText = $state("");
let editKind = $state<MemoryKind>("fact");
let editSubject = $state("org");
let editRepoUrl = $state("");

function openEdit(proposal: MemoryProposal) {
  editing = proposal;
  editText = proposal.text;
  editKind = proposal.kind ?? "fact";
  editSubject = proposal.subject?.kind === "repo" ? "repo" : "org";
  editRepoUrl = proposal.subject?.kind === "repo" ? proposal.subject.url : "";
  editOpen = true;
}

async function submitEditAccept(event: SubmitEvent) {
  event.preventDefault();
  if (editing === null) return;
  busyProposal = editing.id;
  try {
    const memory = await acceptMemoryProposal(fetch, editing.id, {
      text: editText,
      kind: editKind,
      subject: editSubject === "repo" ? { kind: "repo", url: editRepoUrl } : { kind: "org" },
    });
    toast.success(`Promoted as ${memory.id}`);
    editOpen = false;
    await invalidate("app:memory");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to accept the proposal");
  } finally {
    busyProposal = null;
  }
}

async function reject(proposal: MemoryProposal) {
  busyProposal = proposal.id;
  try {
    await rejectMemoryProposal(fetch, proposal.id, "rejected in the memory manager");
    toast.success("Proposal rejected");
    await invalidate("app:memory");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to reject the proposal");
  } finally {
    busyProposal = null;
  }
}

// Flagged proposals surface first: instruction-shaped, contradicting, secret-shaped — the ones
// waiting on a person by design, then the rest in arrival order.
const inbox = $derived(
  [...data.proposals].sort((a, b) =>
    Number(b.flags.length > 0) - Number(a.flags.length > 0) ||
    a.createdAt.localeCompare(b.createdAt)
  ),
);

// Bulk review: a selection over the inbox, resolved in one request.
let selected = $state<Set<string>>(new Set());
let resolving = $state(false);
const allSelected = $derived(inbox.length > 0 && inbox.every((p) => selected.has(p.id)));

function toggle(id: string, on: boolean) {
  const next = new Set(selected);
  if (on) next.add(id);
  else next.delete(id);
  selected = next;
}

function toggleAll(on: boolean) {
  selected = on ? new Set(inbox.map((p) => p.id)) : new Set();
}

async function resolveSelected(action: "accept" | "reject") {
  if (selected.size === 0) return;
  resolving = true;
  try {
    const ids = [...selected];
    const result = await resolveMemoryProposals(
      fetch,
      action === "accept"
        ? { accept: ids }
        : { reject: ids, reason: "rejected in the memory manager" },
    );
    const done = action === "accept" ? result.accepted.length : result.rejected.length;
    toast.success(
      `${action === "accept" ? "Promoted" : "Rejected"} ${done}${
        result.skipped.length > 0 ? `, skipped ${result.skipped.length} no longer pending` : ""
      }`,
    );
    selected = new Set();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Bulk review failed");
  } finally {
    // Either way the list is re-read: a bulk that failed part-way still applied what it applied.
    await invalidate("app:memory");
    resolving = false;
  }
}

async function consolidate() {
  consolidating = true;
  try {
    const stats = await consolidateMemory(fetch);
    toast.success(
      `Consolidated: ${stats.promoted} promoted, ${stats.merged} merged, ${stats.rejected} rejected, ${stats.held} waiting for a person` +
        (stats.awaiting > 0 ? `, ${stats.awaiting} awaiting their change` : "") +
        (stats.judged > 0 ? `, ${stats.judged} judged by the model` : "") +
        (stats.swept > 0 ? `, ${stats.swept} swept` : ""),
    );
    await invalidate("app:memory");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Consolidation failed");
  } finally {
    consolidating = false;
  }
}

const originLabel = (proposal: MemoryProposal) =>
  proposal.origin.kind === "run"
    ? "a run"
    : proposal.origin.kind === "human"
    ? "a person"
    : `a document${proposal.origin.section ? `, § ${proposal.origin.section}` : ""}`;
</script>

<svelte:head>
  <title>Memory · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-6">
  <PageTitle title="Memory">
    {#snippet actions()}
      {#if data.memoryAccessEnabled && canManage}
        <Button onclick={openWrite}>
          <PlusIcon data-icon="inline-start" />
          Write a memory
        </Button>
      {/if}
    {/snippet}
    {#snippet description()}
      What agents know about your org and repositories. Every run starts with a brief drawn
      from it.
    {/snippet}
  </PageTitle>

  {#if data.memoryAccessState === "off"}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon"><BrainIcon /></Empty.Media>
        <Empty.Title>Memory is off</Empty.Title>
        <Empty.Description>
          This deployment runs without the memory service, so runs start without a brief and
          nothing is remembered.
        </Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {:else if data.memoryAccessState === "forbidden"}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon"><LockIcon /></Empty.Media>
        <Empty.Title>You don't have access to memory</Empty.Title>
        <Empty.Description>The memory service refused this account.</Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {:else if data.memoryAccessState === "unavailable"}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon"><BrainIcon /></Empty.Media>
        <Empty.Title>The memory service isn't answering</Empty.Title>
        <Empty.Description>
          It may be restarting. Nothing has changed; reload in a moment.
        </Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {:else}
    <!-- `?tab=inbox` opens on the inbox: where a run's page sends someone to a proposal. -->
    <Tabs.Root value={page.url.searchParams.get("tab") === "inbox" ? "inbox" : "canon"}
      class="gap-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <Tabs.List>
          <Tabs.Trigger value="canon">
            <BrainIcon />
            Memories
          </Tabs.Trigger>
          <Tabs.Trigger value="inbox">
            <InboxIcon />
            Inbox
            {#if data.proposals.length > 0}
              <Badge variant="secondary" class="ml-0.5">{data.proposals.length}</Badge>
            {/if}
          </Tabs.Trigger>
        </Tabs.List>
      </div>

      <Tabs.Content value="canon" class="flex flex-col gap-4">
        <form class="flex flex-wrap items-center gap-2" onsubmit={onSearch} role="search">
          <InputGroup.Root class="min-w-60 flex-1">
            <InputGroup.Addon>
              <SearchIcon />
            </InputGroup.Addon>
            <InputGroup.Input
              id="memory-search"
              aria-label="Search memories"
              bind:value={filters.q}
              placeholder="Search memories"
            />
          </InputGroup.Root>
          <Select.Root type="single" value={filters.subject || ANY} onValueChange={setFilter("subject")}>
            <Select.Trigger class="max-w-56" aria-label="Filter by subject">
              <span class="truncate">
                {filters.subject
                  ? subjectOptions.find((s) => s.key === filters.subject)?.label ?? "Subject"
                  : "Any subject"}
              </span>
            </Select.Trigger>
            <Select.Content>
              <Select.Group>
                <Select.Item value={ANY} label="Any subject" />
                {#each subjectOptions as option (option.key)}
                  <Select.Item value={option.key} label={option.label}>
                    <span class="flex w-full items-center justify-between gap-3">
                      <span class="truncate">{option.label}</span>
                      <span class="text-muted-foreground text-xs">{option.count}</span>
                    </span>
                  </Select.Item>
                {/each}
              </Select.Group>
            </Select.Content>
          </Select.Root>
          <Select.Root type="single" value={filters.kind || ANY} onValueChange={setFilter("kind")}>
            <Select.Trigger aria-label="Filter by kind">
              {filters.kind ? KIND_LABEL[filters.kind] : "Any kind"}
            </Select.Trigger>
            <Select.Content>
              <Select.Group>
                <Select.Item value={ANY} label="Any kind" />
                {#each memoryKindSchema.options as kind (kind)}
                  <Select.Item value={kind} label={KIND_LABEL[kind]} />
                {/each}
              </Select.Group>
            </Select.Content>
          </Select.Root>
          <Select.Root type="single" value={filters.status || ANY} onValueChange={setFilter("status")}>
            <Select.Trigger aria-label="Filter by status">
              {filters.status ? STATUS_LABEL[filters.status] : "Any status"}
            </Select.Trigger>
            <Select.Content>
              <Select.Group>
                <Select.Item value={ANY} label="Any status" />
                {#each memoryStatusSchema.options as status (status)}
                  <Select.Item value={status} label={STATUS_LABEL[status]} />
                {/each}
              </Select.Group>
            </Select.Content>
          </Select.Root>
          <Select.Root type="single" value={filters.trust || ANY} onValueChange={setFilter("trust")}>
            <Select.Trigger aria-label="Filter by source">
              {filters.trust ? TRUST_LABEL[filters.trust] : "Any source"}
            </Select.Trigger>
            <Select.Content>
              <Select.Group>
                <Select.Item value={ANY} label="Any source" />
                {#each memoryTrustSchema.options as trust (trust)}
                  <Select.Item value={trust} label={TRUST_LABEL[trust]} />
                {/each}
              </Select.Group>
            </Select.Content>
          </Select.Root>
          {#if activeFilters > 0}
            <Button type="button" variant="ghost" onclick={clearFilters}>
              <XIcon data-icon="inline-start" />
              Clear
            </Button>
          {/if}
        </form>

        {#if memories.length === 0}
          <Empty.Root class="border border-dashed">
            <Empty.Header>
              <Empty.Media variant="icon"><BrainIcon /></Empty.Media>
              {#if activeFilters > 0}
                <Empty.Title>No memories match</Empty.Title>
                <Empty.Description>Try a different search, or clear the filters.</Empty.Description>
              {:else}
                <Empty.Title>Nothing remembered yet</Empty.Title>
                <Empty.Description>
                  Runs propose memories as they work. You can also write down what agents should
                  know about your org and repositories.
                </Empty.Description>
              {/if}
            </Empty.Header>
            {#if canManage && activeFilters === 0}
              <Empty.Content>
                <Button onclick={openWrite}>
                  <PlusIcon data-icon="inline-start" />
                  Write a memory
                </Button>
              </Empty.Content>
            {/if}
          </Empty.Root>
        {:else}
          <ul class="divide-y rounded-lg border">
            {#each memories as memory (memory.id)}
              {@render memoryRow(memory)}
            {/each}
          </ul>
          {#if hasMore}
            <div class="flex justify-center">
              <Button variant="outline" disabled={loadingMore} onclick={showMore}>
                {#if loadingMore}
                  <Spinner data-icon="inline-start" />
                {/if}
                Show more
              </Button>
            </div>
          {/if}
        {/if}
      </Tabs.Content>

      <Tabs.Content value="inbox" class="flex flex-col gap-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="text-muted-foreground max-w-prose text-sm">
            Proposals from runs that need a person to decide: flagged claims, unconfirmed
            preferences, and anything the consolidator hasn't settled yet.
          </p>
          {#if canManage}
            <Button variant="outline" size="sm" disabled={consolidating} onclick={consolidate}>
              {#if consolidating}
                <Spinner data-icon="inline-start" />
              {:else}
                <SparklesIcon data-icon="inline-start" />
              {/if}
              Consolidate now
            </Button>
          {/if}
        </div>
        {#if data.proposals.length === 0}
          <Empty.Root class="border border-dashed">
            <Empty.Header>
              <Empty.Media variant="icon"><InboxIcon /></Empty.Media>
              <Empty.Title>Nothing to review</Empty.Title>
              <Empty.Description>
                Proposals the consolidator can settle on its own never land here.
              </Empty.Description>
            </Empty.Header>
          </Empty.Root>
        {:else}
          <div class="rounded-lg border">
            {#if canManage}
              <!-- Select-all and the bulk actions, in the list's own header so they sit on the
                   rows they act on. -->
              <div class="bg-muted/40 flex min-h-11 items-center gap-3 border-b px-4 py-1.5 text-sm">
                <Checkbox
                  aria-label="Select every proposal"
                  checked={allSelected}
                  indeterminate={selected.size > 0 && !allSelected}
                  onCheckedChange={(on) => toggleAll(on === true)}
                />
                <span class="text-muted-foreground">
                  {selected.size > 0 ? `${selected.size} selected` : `${inbox.length} waiting`}
                </span>
                {#if selected.size > 0}
                  <div class="ml-auto flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={resolving}
                      onclick={() => resolveSelected("accept")}
                    >
                      <CheckIcon data-icon="inline-start" />
                      Accept
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={resolving}
                      onclick={() => resolveSelected("reject")}
                    >
                      <XIcon data-icon="inline-start" />
                      Reject
                    </Button>
                  </div>
                {/if}
              </div>
            {/if}
            <ul class="divide-y">
              {#each inbox as proposal (proposal.id)}
                {@render proposalRow(proposal)}
              {/each}
            </ul>
          </div>
        {/if}
      </Tabs.Content>
    </Tabs.Root>
  {/if}
</div>

{#snippet subjectChip(subject: MemorySubject | null)}
  {@const shown = subjectDisplay(subject, data.gitlabHost)}
  <span class="flex min-w-0 items-center gap-1" title={shown.full || undefined}>
    {#if shown.provider}
      <ForgeIcon provider={shown.provider} class="size-3.5" />
    {:else if subject?.kind === "org"}
      <BuildingIcon class="size-3.5 shrink-0" />
    {/if}
    <span class="truncate">{shown.label}</span>
  </span>
{/snippet}

{#snippet memoryRow(memory: Memory)}
  <!-- The whole row opens the memory: the claim is the link, stretched over the row. -->
  <li
  class={[
      "hover:bg-muted/40 relative flex flex-col gap-1.5 px-4 py-3 transition-colors",
      memory.status === "retired" && "opacity-60",
    ]}
>
  <!-- The claim with its score beside it; the meta line below runs the row's full width. -->
  <div class="flex gap-4">
    <a
      href="/memory/{memory.id}"
      class="min-w-0 flex-1 text-sm text-pretty after:absolute after:inset-0 focus-visible:outline-none"
    >
        {memory.text}
      </a>
    <div
      class="text-muted-foreground flex shrink-0 items-start pt-0.5 font-mono text-xs tabular-nums"
      title={memory.trust === "pinned" ? "Pinned: always in the brief" : "Ranking score"}
    >
      {#if memory.trust === "pinned"}
        <PinIcon class="size-3.5" />
      {:else}
        {memory.score.total.toFixed(2)}
      {/if}
    </div>
  </div>
  <div class="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <Badge variant="outline">{KIND_LABEL[memory.kind]}</Badge>
        {#if memory.status !== "canon"}
          <Badge variant={memory.status === "retired" ? "secondary" : "destructive"}>
            {STATUS_LABEL[memory.status]}
          </Badge>
        {/if}
        <!-- The badges say what it is; the rest is provenance, pushed to the far edge. -->
        <div class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
        {@render subjectChip(memory.subject)}
        {#if memory.audience.kind === "agent"}
          {@const agentId = memory.audience.agentId}
          <span class="flex items-center gap-1">
            <AgentAvatar {agentId} class="size-4" />
            Only {agentName.get(agentId) ?? agentId}
          </span>
        {/if}
        <span>{TRUST_LABEL[memory.trust]}</span>
        <!-- Only what has happened: a new memory's row of zeroes says nothing. -->
        {#if memory.confirmations > 0 || memory.refutations > 0}
          <span class="flex items-center gap-2" title="Confirmed and refuted by runs">
            {#if memory.confirmations > 0}
              <span class="flex items-center gap-0.5">
                <ThumbsUpIcon class="size-3" />{memory.confirmations}
              </span>
            {/if}
            {#if memory.refutations > 0}
              <span class="flex items-center gap-0.5">
                <ThumbsDownIcon class="size-3" />{memory.refutations}
              </span>
            {/if}
          </span>
        {/if}
        {#if memory.briefedCount > 0}
          <span>In {memory.briefedCount} {memory.briefedCount === 1 ? "brief" : "briefs"}</span>
        {/if}
        <span>{memory.age}</span>
        </div>
      </div>
</li>
{/snippet}

{#snippet proposalRow(proposal: MemoryProposal)}
  <li id="proposal-{proposal.id}" class="target:bg-muted/60 flex scroll-mt-24 gap-3 px-4 py-3">
    {#if canManage}
      <Checkbox
        class="mt-0.5"
        aria-label="Select this proposal"
        checked={selected.has(proposal.id)}
        onCheckedChange={(on) => toggle(proposal.id, on === true)}
      />
    {/if}
    <div class="flex min-w-0 flex-1 flex-col gap-1.5">
      <!-- The claim with its actions beside it; the meta line below runs the full width, as in the
           memory rows. -->
      <div class="flex gap-4">
        <p class="min-w-0 flex-1 text-sm text-pretty">{proposal.text}</p>
        {#if canManage}
          <div class="flex shrink-0 items-start gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Accept"
              title="Accept"
              disabled={busyProposal === proposal.id}
              onclick={() => accept(proposal)}
            >
              <CheckIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Edit and accept"
              title="Edit and accept"
              disabled={busyProposal === proposal.id}
              onclick={() => openEdit(proposal)}
            >
              <PencilIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Reject"
              title="Reject"
              disabled={busyProposal === proposal.id}
              onclick={() => reject(proposal)}
            >
              <XIcon />
            </Button>
          </div>
        {/if}
      </div>
      <div class="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {#each proposal.flags as flag (flag)}
          <Badge variant="destructive">{flag}</Badge>
        {/each}
        {#if proposal.change !== null && proposal.change.fate === "pending"}
          <Badge
            variant="outline"
            title="The run's own change makes this true, so it waits until that patch lands"
          >
            {#if proposal.change.forgeUrl}
              <a href={proposal.change.forgeUrl} target="_blank" rel="noreferrer">
                Waits for its patch to land
              </a>
            {:else}
              Waits for its patch to land
            {/if}
          </Badge>
        {/if}
        <Badge variant="outline">{KIND_LABEL[proposal.kind ?? "fact"]}</Badge>
        <!-- The badges say what it is; the rest is provenance, pushed to the far edge. -->
        <div class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
        {@render subjectChip(proposal.subject)}
        {#if proposal.supersedes}
          <a href="/memory/{proposal.supersedes}" class="underline-offset-4 hover:underline">
            Replaces a memory
          </a>
        {/if}
        <span>
          From
          {#if proposal.origin.kind === "source"}
            <a
              href="/memory/sources/{proposal.origin.sourceId}"
              class="underline-offset-4 hover:underline"
            >{originLabel(proposal)}</a>
          {:else if proposal.origin.kind === "run"}
            <a href="/tasks/{proposal.origin.taskId}" class="underline-offset-4 hover:underline">
              {originLabel(proposal)}
            </a>
          {:else}
            {originLabel(proposal)}
          {/if}
        </span>
        </div>
      </div>
    </div>
  </li>
{/snippet}

<Dialog.Root bind:open={writeOpen}>
  <Dialog.Content>
    <form class="flex flex-col gap-4" onsubmit={submitWrite}>
      <Dialog.Header>
        <Dialog.Title>Write a memory</Dialog.Title>
        <Dialog.Description>
          One claim, written the way an agent should read it. It's used right away, marked as
          coming from a person.
        </Dialog.Description>
      </Dialog.Header>
      <Field.FieldGroup>
        <Field.Field>
          <Field.FieldLabel for="memory-text">Claim</Field.FieldLabel>
          <Textarea
            id="memory-text"
            bind:value={writeText}
            rows={4}
            required
            maxlength={500}
            placeholder="App tests are vitest, wired in via package.json scripts.test; npm test runs them."
          />
          <Field.FieldDescription>At most 500 characters. Never a credential.</Field.FieldDescription>
        </Field.Field>
        <Field.Field>
          <Field.FieldLabel for="memory-kind">Kind</Field.FieldLabel>
          <Select.Root type="single" bind:value={writeKind}>
            <Select.Trigger id="memory-kind" class="w-full">{KIND_LABEL[writeKind]}</Select.Trigger>
            <Select.Content>
              <Select.Group>
                {#each memoryKindSchema.options as kind (kind)}
                  <Select.Item value={kind} label={KIND_LABEL[kind]} />
                {/each}
              </Select.Group>
            </Select.Content>
          </Select.Root>
        </Field.Field>
        <SubjectPicker
          id="memory"
          bind:subject={writeSubject}
          bind:repoUrl={writeRepoUrl}
          suggestions={knownRepos}
        />
        <div class="flex items-center gap-2">
          <Checkbox id="memory-pinned" bind:checked={writePinned} />
          <Label for="memory-pinned">Pin it, so it's always in the brief</Label>
        </div>
      </Field.FieldGroup>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => (writeOpen = false)}>Cancel</Button>
        <Button type="submit" disabled={writing}>
          {#if writing}
            <Spinner data-icon="inline-start" />
          {:else}
            <PlusIcon data-icon="inline-start" />
          {/if}
          Record
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={editOpen}>
  <Dialog.Content>
    <form class="flex flex-col gap-4" onsubmit={submitEditAccept}>
      <Dialog.Header>
        <Dialog.Title>Edit and accept</Dialog.Title>
        <Dialog.Description>
          Correct the claim before it's accepted. It's then marked as coming from a person.
        </Dialog.Description>
      </Dialog.Header>
      <Field.FieldGroup>
        <Field.Field>
          <Field.FieldLabel for="edit-accept-text">Claim</Field.FieldLabel>
          <Textarea id="edit-accept-text" bind:value={editText} rows={4} required maxlength={500} />
        </Field.Field>
        <Field.Field>
          <Field.FieldLabel for="edit-accept-kind">Kind</Field.FieldLabel>
          <Select.Root type="single" bind:value={editKind}>
            <Select.Trigger id="edit-accept-kind"
              class="w-full">{KIND_LABEL[editKind]}</Select.Trigger>
            <Select.Content>
              <Select.Group>
                {#each memoryKindSchema.options as kind (kind)}
                  <Select.Item value={kind} label={KIND_LABEL[kind]} />
                {/each}
              </Select.Group>
            </Select.Content>
          </Select.Root>
        </Field.Field>
        <SubjectPicker
          id="edit-accept"
          bind:subject={editSubject}
          bind:repoUrl={editRepoUrl}
          suggestions={knownRepos}
        />
      </Field.FieldGroup>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => (editOpen = false)}>Cancel</Button>
        <Button type="submit" disabled={busyProposal !== null}>
          {#if busyProposal !== null}<Spinner data-icon="inline-start" />{:else}<CheckIcon data-icon="inline-start" />{/if}
          Accept
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
