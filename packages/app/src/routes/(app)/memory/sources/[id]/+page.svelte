<script lang="ts">
import { can } from "$lib/utils/auth/capabilities";
import ObjectHeader from "$lib/components/object-header/object-header.svelte";
import { goto, invalidate } from "$app/navigation";
import { moveMemorySource, resolveMemoryProposals, withdrawMemorySource } from "$lib/api/memory";
import { SubjectPicker } from "$lib/components/subject-picker";
import type { MemoryProposal, MemorySourceKind } from "$lib/api/types";
import { KIND_LABEL, STATUS_LABEL, subjectDisplay } from "../../labels";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Dialog from "$lib/components/ui/dialog";
import * as Field from "$lib/components/ui/field";
import { Checkbox } from "$lib/components/ui/checkbox";
import { Spinner } from "$lib/components/ui/spinner";
import { formatDateTime, formatRelativeTime } from "$lib/utils/format";
import ForgeIcon from "$lib/components/forge-icon/forge-icon.svelte";
import Markdown from "$lib/components/markdown/markdown.svelte";
import * as Collapsible from "$lib/components/ui/collapsible";
import BuildingIcon from "@lucide/svelte/icons/building-2";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import FolderInputIcon from "@lucide/svelte/icons/folder-input";
import CheckIcon from "@lucide/svelte/icons/check";
import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
import FileTextIcon from "@lucide/svelte/icons/file-text";
import Trash2Icon from "@lucide/svelte/icons/trash-2";
import XIcon from "@lucide/svelte/icons/x";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const canManage = $derived(can(data.user, "memory:manage"));
const { source, sections, memories } = $derived(data.detail);
const pending = $derived(data.detail.proposals.filter((p) => p.status === "pending"));
const settled = $derived(data.detail.proposals.filter((p) => p.status !== "pending"));

let selected = $state<Set<string>>(new Set());
let resolving = $state(false);
// While the extraction still runs behind this source, the page follows it.
$effect(() => {
  if (source.status !== "ingesting") return;
  const timer = setInterval(() => void invalidate("app:memory"), 2500);
  return () => clearInterval(timer);
});

// Move: the batch was ingested about the wrong subject. Every pending proposal, every live
// memory and the source's own default take the right one.
let moveOpen = $state(false);
let moving = $state(false);
let moveSubject = $state("org");
let moveRepoUrl = $state("");
const knownRepos = $derived(
  [...new Set(data.subjects.flatMap((s) => (s.subject.kind === "repo" ? [s.subject.url] : [])))],
);

function openMove() {
  moveSubject = source.defaultSubject.kind;
  moveRepoUrl = source.defaultSubject.kind === "repo" ? source.defaultSubject.url : "";
  moveOpen = true;
}

async function submitMove(event: SubmitEvent) {
  event.preventDefault();
  moving = true;
  try {
    const done = await moveMemorySource(
      fetch,
      source.id,
      moveSubject === "repo" ? { kind: "repo", url: moveRepoUrl } : { kind: "org" },
    );
    toast.success(
      `Moved to ${
        done.subject.kind === "org" ? "the org" : done.subject.url
      }: ${done.proposals} proposals, ${done.memories} memories`,
    );
    moveOpen = false;
    await invalidate("app:memory");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Move failed");
  } finally {
    moving = false;
  }
}

let withdrawOpen = $state(false);
let withdrawing = $state(false);
const livePinned = $derived(
  memories.filter((m) => m.status !== "retired" && m.trust === "pinned").length,
);
const allSelected = $derived(pending.length > 0 && pending.every((p) => selected.has(p.id)));

function toggle(id: string, on: boolean) {
  const next = new Set(selected);
  if (on) next.add(id);
  else next.delete(id);
  selected = next;
}

/** The resolve route takes at most this many ids per array, and a batch here can be far more. */
const RESOLVE_CHUNK = 200;

// A whole batch goes in runs of RESOLVE_CHUNK, one after the other. A run that fails stops the
// rest and the list is re-read either way, so the page shows exactly what did land.
async function resolve(action: "accept" | "reject", ids: string[]) {
  if (ids.length === 0) return;
  resolving = true;
  let done = 0;
  try {
    for (let from = 0; from < ids.length; from += RESOLVE_CHUNK) {
      const chunk = ids.slice(from, from + RESOLVE_CHUNK);
      const result = await resolveMemoryProposals(
        fetch,
        action === "accept" ? { accept: chunk } : { reject: chunk, reason: "rejected in review" },
      );
      done += action === "accept" ? result.accepted.length : result.rejected.length;
    }
    toast.success(`${action === "accept" ? "Promoted" : "Rejected"} ${done}`);
    selected = new Set();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Review failed");
  } finally {
    await invalidate("app:memory");
    resolving = false;
  }
}

async function withdraw() {
  withdrawing = true;
  try {
    const done = await withdrawMemorySource(fetch, source.id);
    toast.success(
      `Withdrawn: ${done.rejected} rejected, ${done.retired} retired` +
        (done.kept > 0 ? `, ${done.kept} pinned kept` : ""),
    );
    await goto("/memory/sources", { invalidate: ["app:memory"] });
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Withdraw failed");
    withdrawing = false;
  }
}

const SOURCE_KIND_LABEL: Record<MemorySourceKind, string> = {
  paste: "Pasted",
  upload: "Uploaded",
  url: "From a URL",
  "repo-file": "From a repository file",
};

// What happened to a settled proposal, in words, and the memory it became when it became one.
function outcome(p: MemoryProposal): { label: string; memoryId: string | null } {
  const memoryId = p.resolution && "memoryId" in p.resolution ? p.resolution.memoryId : null;
  if (p.status === "promoted") return { label: "Became a memory", memoryId };
  if (p.status === "merged") return { label: "Merged into a memory", memoryId };
  const reason = p.resolution && "reason" in p.resolution ? p.resolution.reason : null;
  return { label: reason ? `Rejected: ${reason}` : "Rejected", memoryId: null };
}

// Live first, the retired after them: they are the record, not the result.
const sortedMemories = $derived(
  [...memories].sort((a, b) => Number(a.status === "retired") - Number(b.status === "retired")),
);
const liveCount = $derived(memories.filter((m) => m.status !== "retired").length);
const subject = $derived(subjectDisplay(source.defaultSubject));
</script>

<svelte:head>
  <title>{source.title} · Memory · Ryph</title>
</svelte:head>

{#snippet sourceActions()}
  <Button variant="outline" disabled={moving || withdrawing} onclick={openMove}>
      <FolderInputIcon data-icon="inline-start" />
      Move
    </Button>
    <Button variant="destructive" disabled={withdrawing} onclick={() => (withdrawOpen = true)}>
      <Trash2Icon data-icon="inline-start" />
      Withdraw
    </Button>
{/snippet}

<div class="flex flex-col gap-10">
  <ObjectHeader title={source.title} actions={canManage ? sourceActions : undefined}>
    {#snippet icon()}
      <FileTextIcon />
    {/snippet}
    <div class="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <span>{SOURCE_KIND_LABEL[source.kind]}</span>
      <span class="flex min-w-0 items-center gap-1.5" title={subject.full}>
        {#if subject.provider}
          <ForgeIcon provider={subject.provider} class="size-3.5" />
        {:else}
          <BuildingIcon class="size-3.5" />
        {/if}
        <span class="truncate">{subject.label}</span>
      </span>
      <span title={formatDateTime(source.ingestedAt)}>
        Added {formatRelativeTime(source.ingestedAt)}
      </span>
      {#if source.locator}
        {#if /^https?:\/\//.test(source.locator)}
          <a
            href={source.locator}
            target="_blank"
            rel="noreferrer"
            class="text-foreground decoration-muted-foreground/50 hover:decoration-foreground truncate underline underline-offset-4"
          >
            {source.locator}
          </a>
        {:else}
          <span class="truncate font-mono text-xs">{source.locator}</span>
        {/if}
      {/if}
      {#if source.supersedesSourceId}
        <a
          href="/memory/sources/{source.supersedesSourceId}"
          class="text-foreground decoration-muted-foreground/50 hover:decoration-foreground underline underline-offset-4"
        >
          Replaces an earlier version
        </a>
      {/if}
    </div>
    {#if source.status === "ingesting"}
      <p class="text-muted-foreground flex items-center gap-1.5 text-sm">
        <Spinner class="size-3.5" />
        Reading it section by section. Claims appear below as they're found.
      </p>
    {:else if source.status === "failed"}
      <p class="text-destructive flex items-center gap-1.5 text-sm">
        <CircleAlertIcon class="size-3.5" />
        Couldn't read it: {source.failure ?? "no reason recorded"}. Withdraw it and add it again.
      </p>
    {:else if source.extraction && !source.extraction.modelBacked}
      <p class="text-muted-foreground text-sm">
        Added without a platform model, so agents read it whole instead of as separate claims.
      </p>
    {:else if source.extraction}
      <p class="text-sm">
        {source.extraction.extracted} claims from {source.extraction.sections}
        {source.extraction.sections === 1 ? "section" : "sections"}
        {#if source.extraction.failed > 0}
          <span class="text-muted-foreground">
            ({source.extraction.failed} {source.extraction.failed === 1 ? "section" : "sections"}
            couldn't be read)
          </span>
        {/if}
      </p>
    {/if}
  </ObjectHeader>

  <!-- Only while something is waiting: an empty review card was most of what a settled document
       showed first. -->
  {#if pending.length > 0}
    <section class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <h2 class="text-base font-medium">To review</h2>
        <p class="text-muted-foreground text-sm">
          Claims found in this document that are waiting for a person. Nothing reaches an agent
          until it's accepted.
        </p>
      </div>
      <div class="rounded-lg border">
        {#if canManage}
          <div class="bg-muted/40 flex min-h-11 items-center gap-3 border-b px-4 py-1.5 text-sm">
            <Checkbox
              aria-label="Select every claim"
              checked={allSelected}
              indeterminate={selected.size > 0 && !allSelected}
              onCheckedChange={(on) =>
                (selected = on === true ? new Set(pending.map((p) => p.id)) : new Set())}
            />
            <span class="text-muted-foreground">
              {selected.size > 0 ? `${selected.size} selected` : `${pending.length} waiting`}
            </span>
            <div class="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={resolving}
                onclick={() =>
                  resolve("accept", selected.size > 0 ? [...selected] : pending.map((p) => p.id))}
              >
                <CheckIcon data-icon="inline-start" />
                {selected.size > 0 ? "Accept" : "Accept all"}
              </Button>
              {#if selected.size > 0}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={resolving}
                  onclick={() => resolve("reject", [...selected])}
                >
                  <XIcon data-icon="inline-start" />
                  Reject
                </Button>
              {/if}
            </div>
          </div>
        {/if}
        <ul class="divide-y">
          {#each pending as proposal (proposal.id)}
            <li class="flex gap-3 px-4 py-3">
              {#if canManage}
                <Checkbox
                  class="mt-0.5"
                  aria-label="Select this claim"
                  checked={selected.has(proposal.id)}
                  onCheckedChange={(on) => toggle(proposal.id, on === true)}
                />
              {/if}
              <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                <p class="text-sm text-pretty">{proposal.text}</p>
                <div class="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  {#each proposal.flags as flag (flag)}
                    <Badge variant="destructive">{flag}</Badge>
                  {/each}
                  <Badge variant="outline">{KIND_LABEL[proposal.kind ?? "fact"]}</Badge>
                  {#if proposal.origin.kind === "source" && proposal.origin.section}
                    <span class="ml-auto truncate">{proposal.origin.section}</span>
                  {/if}
                </div>
              </div>
            </li>
          {/each}
        </ul>
      </div>
    </section>
  {/if}

  {#if memories.length > 0}
    <section class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <h2 class="text-base font-medium">Memories from this document</h2>
        <p class="text-muted-foreground text-sm">
          {liveCount} in use{memories.length > liveCount
            ? `, ${memories.length - liveCount} retired`
            : ""}.
        </p>
      </div>
      <ul class="divide-y rounded-lg border">
        {#each sortedMemories as memory (memory.id)}
          <li
            class={[
              "hover:bg-muted/40 relative flex flex-col gap-1.5 px-4 py-3 transition-colors",
              memory.status === "retired" && "opacity-60",
            ]}
          >
            <a
              href="/memory/{memory.id}"
              class="text-sm text-pretty after:absolute after:inset-0 focus-visible:outline-none"
            >
              {memory.text}
            </a>
            <div class="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{KIND_LABEL[memory.kind]}</Badge>
              {#if memory.status !== "canon"}
                <Badge variant={memory.status === "retired" ? "secondary" : "destructive"}>
                  {STATUS_LABEL[memory.status]}
                </Badge>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <!-- The audit trail: every claim that was settled, and how. Folded, since the memories above
       are what it came to. -->
  {#if settled.length > 0}
    <Collapsible.Root class="group/settled flex flex-col gap-3">
      <Collapsible.Trigger
        class="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1.5 text-sm"
      >
        <ChevronRightIcon class="size-4 transition-transform group-data-[state=open]/settled:rotate-90" />
        {settled.length} settled {settled.length === 1 ? "claim" : "claims"}
      </Collapsible.Trigger>
      <Collapsible.Content>
        <ul class="divide-y rounded-lg border text-sm">
          {#each settled as proposal (proposal.id)}
            {@const result = outcome(proposal)}
            <li class="flex flex-col gap-1 px-4 py-2.5">
              <p class="text-muted-foreground text-pretty">{proposal.text}</p>
              <p class="text-xs">
                {#if result.memoryId}
                  <a
                    href="/memory/{result.memoryId}"
                    class="decoration-muted-foreground/50 hover:decoration-foreground underline underline-offset-4"
                  >
                    {result.label}
                  </a>
                {:else}
                  <span class="text-muted-foreground">{result.label}</span>
                {/if}
              </p>
            </li>
          {/each}
        </ul>
      </Collapsible.Content>
    </Collapsible.Root>
  {/if}

  <section class="flex flex-col gap-3">
    <div class="flex flex-col gap-1">
      <h2 class="text-base font-medium">The document</h2>
      <p class="text-muted-foreground text-sm">
        {sections.length} {sections.length === 1 ? "section" : "sections"}, as agents read it.
      </p>
    </div>
    <ul class="divide-y rounded-lg border">
      <!-- Keyed by position: a heading path repeats across a document. -->
      {#each sections as section, i (i)}
        <li>
          <Collapsible.Root class="group/section">
            <Collapsible.Trigger
              class="hover:bg-muted/40 flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-medium"
            >
              <ChevronRightIcon
                class="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=open]/section:rotate-90"
              />
              <!-- A section's title is its heading path; the parents are context, the last is it. -->
              {@const path = section.title.split(" › ")}
              <span class="truncate">
                {#if path.length > 1}
                  <span class="text-muted-foreground font-normal">
                    {path.slice(0, -1).join(" › ")} ›
                  </span>
                {/if}
                {path.at(-1)}
              </span>
            </Collapsible.Trigger>
            <Collapsible.Content>
              <div class="border-t px-4 py-3 pl-10">
                <Markdown content={section.text} class="text-sm" />
              </div>
            </Collapsible.Content>
          </Collapsible.Root>
        </li>
      {/each}
    </ul>
  </section>
</div>

<AlertDialog.Root bind:open={withdrawOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Withdraw this document?</AlertDialog.Title>
      <AlertDialog.Description>
        The {pending.length} proposals still waiting are rejected, the memories it produced are
        retired{livePinned > 0 ? ` (the ${livePinned} pinned stay — a person vouched for those)` : ""},
        and the record goes. The same text can then be ingested again, under the right title.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Keep it</AlertDialog.Cancel>
      <AlertDialog.Action
        onclick={() => {
          withdrawOpen = false;
          void withdraw();
        }}
      >
        Withdraw
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<Dialog.Root bind:open={moveOpen}>
  <Dialog.Content>
    <form class="flex flex-col gap-4" onsubmit={submitMove}>
      <Dialog.Header>
        <Dialog.Title>Move this document</Dialog.Title>
        <Dialog.Description>
          What it is really about. The {pending.length} proposals still waiting, the
          {memories.filter((m) => m.status !== "retired").length} live memories it produced and
          the document itself all take the new subject; nothing else about them changes.
        </Dialog.Description>
      </Dialog.Header>
      <Field.FieldGroup>
        <SubjectPicker id="move" bind:subject={moveSubject} bind:repoUrl={moveRepoUrl}
          suggestions={knownRepos} />
      </Field.FieldGroup>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => (moveOpen = false)}>Cancel</Button>
        <Button type="submit" disabled={moving}>
          {#if moving}<Spinner data-icon="inline-start" />{/if}
          Move
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
