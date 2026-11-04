<script lang="ts">
import { can } from "$lib/utils/auth/capabilities";
import { invalidate } from "$app/navigation";
import { pinMemory, retireMemory, unpinMemory, updateMemory } from "$lib/api/memory";
import { type MemoryKind, memoryKindSchema, memorySubjectKey } from "$lib/api/types";
import { SubjectPicker } from "$lib/components/subject-picker";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Card from "$lib/components/ui/card";
import * as Dialog from "$lib/components/ui/dialog";
import * as Field from "$lib/components/ui/field";
import * as Select from "$lib/components/ui/select";
import { Spinner } from "$lib/components/ui/spinner";
import * as Table from "$lib/components/ui/table";
import { Textarea } from "$lib/components/ui/textarea";
import { shortCommit } from "$lib/utils/environments";
import { formatDateTime, formatRelativeTime } from "$lib/utils/format";
import ArrowUpRightIcon from "@lucide/svelte/icons/arrow-up-right";
import ArchiveIcon from "@lucide/svelte/icons/archive";
import PencilIcon from "@lucide/svelte/icons/pencil";
import PinIcon from "@lucide/svelte/icons/pin";
import PinOffIcon from "@lucide/svelte/icons/pin-off";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const canManage = $derived(can(data.user, "memory:manage"));
const memory = $derived(data.detail.memory);
const pinned = $derived(memory.trust === "pinned");

let busy = $state(false);

async function act(label: string, work: () => Promise<unknown>) {
  busy = true;
  try {
    await work();
    toast.success(label);
    await invalidate("app:memory");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : `Failed: ${label}`);
  } finally {
    busy = false;
  }
}

// ── edit ────────────────────────────────────────────────────────────────────────────────────
let editOpen = $state(false);
let editText = $state("");
let editKind = $state<MemoryKind>("fact");
let editSubject = $state("org");
let editRepoUrl = $state("");
/** "all", or an agent's id. */
let editAudience = $state("all");
const knownRepos = $derived(
  [...new Set(data.subjects.flatMap((s) => (s.subject.kind === "repo" ? [s.subject.url] : [])))],
);
const agentName = (id: string) => data.agents.find((a) => a.id === id)?.name ?? id;

function openEdit() {
  editText = memory.text;
  editKind = memory.kind;
  editSubject = memory.subject.kind;
  editRepoUrl = memory.subject.kind === "repo" ? memory.subject.url : "";
  editAudience = memory.audience.kind === "all" ? "all" : memory.audience.agentId;
  editOpen = true;
}

// The dialog closes only once the save landed: a failure keeps the text to try again with.
async function submitEdit(event: SubmitEvent) {
  event.preventDefault();
  busy = true;
  try {
    await updateMemory(fetch, memory.id, {
      text: editText,
      kind: editKind,
      subject: editSubject === "repo" ? { kind: "repo", url: editRepoUrl } : { kind: "org" },
      audience: editAudience === "all" ? { kind: "all" } : { kind: "agent", agentId: editAudience },
    });
    toast.success("Saved");
    editOpen = false;
    await invalidate("app:memory");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to save the memory");
  } finally {
    busy = false;
  }
}

let retireOpen = $state(false);

const provenance = $derived.by(() => {
  const p = memory.provenance;
  // A run is read on its task's page; a document on its own.
  if (p.kind === "run") return { label: "A run", href: `/tasks/${p.taskId}` };
  if (p.kind === "source") {
    return {
      label: `A document${p.section ? `, § ${p.section}` : ""}`,
      href: `/memory/sources/${p.sourceId}`,
    };
  }
  return { label: "Written by a person", href: null };
});

const feedbackLine = (f: (typeof data.detail.feedback)[number]) => {
  switch (f.kind) {
    case "confirm": {
      const who = f.runId ? `confirmed by run ${f.runId}` : "confirmed by a duplicate proposal";
      return f.reanchoredTo ? `${who} (evidence re-anchored to ${f.reanchoredTo})` : who;
    }
    case "refute":
      return `refuted by run ${f.runId}: ${f.reason ?? ""}${
        f.replacementProposalId ? ` (replacement ${f.replacementProposalId})` : ""
      }`;
    case "briefed":
      return `briefed into run ${f.runId}`;
    case "outcome":
      return `run ${f.runId} ended: ${f.status}`;
    case "stale":
      return `flagged stale by run ${f.runId}`;
    case "sweep":
      return f.reason === "source-superseded"
        ? "swept: its source was superseded"
        : "swept: decayed";
    case "human":
      return `${f.action} by ${f.userId}`;
  }
};
import { KIND_LABEL, STATUS_LABEL, subjectDisplay, TRUST_LABEL } from "../labels";

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

// What runs have said about it, as a sentence: the votes factor's inputs, without its arithmetic.
const trackRecord = $derived.by(() => {
  const parts = [
    memory.confirmations > 0 && `Confirmed ${times(memory.confirmations)}`,
    memory.refutations > 0 && `refuted ${times(memory.refutations)}`,
    memory.briefedSuccesses > 0 &&
    `in the brief of ${memory.briefedSuccesses} successful ${
      memory.briefedSuccesses === 1 ? "run" : "runs"
    }`,
  ].filter((p): p is string => Boolean(p));
  if (parts.length === 0) return "No run has confirmed or refuted it yet.";
  const sentence = parts.join(", ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
});

function ageLabel(days: number): string {
  const d = Math.round(days);
  if (d < 1) return "today";
  if (d === 1) return "yesterday";
  if (d < 60) return `${d} days ago`;
  return `${Math.round(d / 30)} months ago`;
}
</script>

<svelte:head>
  <title>{memory.id} · Memory · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-6">
  <div class="flex items-start justify-between gap-4">
    <div class="flex flex-col gap-2">
      <h1 class="max-w-3xl text-lg leading-relaxed text-pretty">{memory.text}</h1>
      <div class="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{KIND_LABEL[memory.kind]}</Badge>
        {#if memory.status !== "canon"}
          <Badge variant={memory.status === "retired" ? "secondary" : "destructive"}>
            {STATUS_LABEL[memory.status]}
          </Badge>
        {/if}
        <Badge variant={pinned ? "default" : "secondary"}>{TRUST_LABEL[memory.trust]}</Badge>
        <span class="text-muted-foreground font-mono text-xs">{memory.id}</span>
      </div>
    </div>
    {#if canManage && memory.status !== "retired"}
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={busy} onclick={openEdit}>
          <PencilIcon data-icon="inline-start" />
          Edit
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onclick={() =>
            act(pinned ? "Unpinned" : "Pinned", () =>
              pinned ? unpinMemory(fetch, memory.id) : pinMemory(fetch, memory.id))}
        >
          {#if pinned}
            <PinOffIcon data-icon="inline-start" />
            Unpin
          {:else}
            <PinIcon data-icon="inline-start" />
            Pin
          {/if}
        </Button>
        <Button variant="destructive" size="sm" disabled={busy} onclick={() => (retireOpen = true)}>
          <ArchiveIcon data-icon="inline-start" />
          Retire
        </Button>
      </div>
    {/if}
  </div>

  <div class="grid gap-6 md:grid-cols-2">
    <Card.Root>
      <Card.Header>
        <Card.Title>About</Card.Title>
      </Card.Header>
      <!-- Stacked label over value, as the Ranking card beside it. -->
      <Card.Content>
        <dl class="flex flex-col gap-3 text-sm">
          <div class="flex flex-col">
            <dt class="font-medium">Subject</dt>
            <dd>
              <a
                href="/memory?subject={encodeURIComponent(memorySubjectKey(memory.subject))}"
                class="text-foreground decoration-muted-foreground/50 hover:decoration-foreground underline underline-offset-4"
                title="Every memory about this"
              >
                {subjectDisplay(memory.subject).label}
              </a>
            </dd>
          </div>
          <div class="flex flex-col">
            <dt class="font-medium">For</dt>
            <dd class="text-muted-foreground">
              {#if memory.audience.kind === "all"}
                Every agent
              {:else}
                {@const agentId = memory.audience.agentId}
                Only {data.agents.find((a) => a.id === agentId)?.name ?? agentId}
              {/if}
            </dd>
          </div>
          <div class="flex flex-col">
            <dt class="font-medium">Came from</dt>
            <dd class="text-muted-foreground">
              {#if provenance.href}<a
                  href={provenance.href}
                  class="text-foreground decoration-muted-foreground/50 hover:decoration-foreground underline underline-offset-4"
                >{provenance.label}<ArrowUpRightIcon
                    class="ml-0.5 inline size-3.5 align-[-2px]"
                  /></a>{:else}{provenance.label}{/if}<span
                title={formatDateTime(memory.createdAt)}
              >, {formatRelativeTime(memory.createdAt)}</span>
            </dd>
          </div>
          {#if memory.evidence}
            <div class="flex flex-col">
              <dt class="font-medium">Evidence</dt>
              <dd class="text-muted-foreground flex flex-col font-mono text-xs">
                <span>At {shortCommit(memory.evidence.sha)}</span>
                {#each memory.evidence.paths as path (path)}
                  <span class="truncate" title={path}>{path}</span>
                {/each}
              </dd>
            </div>
          {/if}
          {#if data.detail.supersedes}
            <div class="flex flex-col">
              <dt class="font-medium">Replaces</dt>
              <dd>
                <a
                  href="/memory/{data.detail.supersedes.id}"
                  class="line-clamp-2 text-foreground decoration-muted-foreground/50 hover:decoration-foreground underline underline-offset-4"
                >
                  {data.detail.supersedes.text}
                </a>
              </dd>
            </div>
          {/if}
          {#if data.detail.supersededBy}
            <div class="flex flex-col">
              <dt class="font-medium">Replaced by</dt>
              <dd>
                <a
                  href="/memory/{data.detail.supersededBy.id}"
                  class="line-clamp-2 text-foreground decoration-muted-foreground/50 hover:decoration-foreground underline underline-offset-4"
                >
                  {data.detail.supersededBy.text}
                </a>
              </dd>
            </div>
          {/if}
        </dl>
      </Card.Content>
    </Card.Root>

    <!-- The ranking, in words: what raised or lowered it, each beside what it contributes, and
         the product of them at the top. The formula itself lives in the memory service; a person
         only needs to know which way each thing pushed. -->
    <Card.Root>
      <Card.Header>
        <Card.Title>Ranking</Card.Title>
        <Card.Description>
          {pinned
            ? "Pinned, so it's in every brief regardless of score."
            : "How it ranks when a run's brief is drawn up. Higher ranks first."}
        </Card.Description>
        <Card.Action class="font-mono text-2xl font-semibold tabular-nums">
          {#if pinned}<PinIcon class="size-5" />{:else}{memory.score.total.toFixed(2)}{/if}
        </Card.Action>
      </Card.Header>
      {#if !pinned}
        <Card.Content>
          <dl class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-3 text-sm">
            <div class="flex flex-col">
              <dt class="font-medium">Source</dt>
              <dd class="text-muted-foreground">{TRUST_LABEL[memory.trust]}</dd>
            </div>
            <dd class="text-muted-foreground self-center font-mono text-xs">
              ×{memory.score.trust}
            </dd>

            <div class="flex flex-col">
              <dt class="font-medium">Track record</dt>
              <dd class="text-muted-foreground">{trackRecord}</dd>
            </div>
            <dd class="text-muted-foreground self-center font-mono text-xs">
              ×{memory.score.votes.toFixed(2)}
            </dd>

            <div class="flex flex-col">
              <dt class="font-medium">Freshness</dt>
              <dd class="text-muted-foreground">
                {memory.lastConfirmedAt ? "Last confirmed" : "Recorded"}
                {ageLabel(memory.score.ageDays)}. It fades slowly unless runs keep confirming it.
              </dd>
            </div>
            <dd class="text-muted-foreground self-center font-mono text-xs">
              ×{memory.score.decay.toFixed(2)}
            </dd>
          </dl>
        </Card.Content>
      {/if}
      <Card.Footer class="text-muted-foreground text-xs">
        {#if memory.briefedCount === 0}
          Not in any brief yet.
        {:else}
          In {memory.briefedCount} {memory.briefedCount === 1 ? "brief" : "briefs"}{#if memory.lastBriefedAt},
            most recently {formatDateTime(memory.lastBriefedAt)}{/if}.
        {/if}
      </Card.Footer>
    </Card.Root>
  </div>

  <Card.Root>
    <Card.Header>
      <Card.Title>Signals</Card.Title>
      <Card.Description>Every confirmation, refutation, brief and human action, newest first.</Card.Description>
    </Card.Header>
    <Card.Content class="text-sm">
      {#if data.detail.feedback.length === 0}
        <p class="text-muted-foreground">Nothing yet.</p>
      {:else}
        <ul class="flex flex-col gap-1">
          {#each data.detail.feedback as f, i (i)}
            <li class="flex gap-3">
              <span class="text-muted-foreground w-40 shrink-0 text-xs">{formatDateTime(f.at)}</span>
              <span>{feedbackLine(f)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </Card.Content>
  </Card.Root>

  {#if data.detail.runs.length > 0}
    <Card.Root>
      <Card.Header>
        <Card.Title>Runs briefed with it</Card.Title>
      </Card.Header>
      <Card.Content class="text-sm">
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Run</Table.Head>
              <Table.Head>Agent</Table.Head>
              <Table.Head>Repo</Table.Head>
              <Table.Head>Outcome</Table.Head>
              <Table.Head>When</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each data.detail.runs as run (run.runId)}
              <Table.Row>
                <Table.Cell class="font-mono text-xs">
                  <a href="/tasks/{run.taskId}" class="underline-offset-4 hover:underline">
                    {run.runId}
                  </a>
                </Table.Cell>
                <Table.Cell class="font-mono text-xs">{run.agentId}</Table.Cell>
                <Table.Cell class="text-muted-foreground whitespace-normal">
                  {run.repos.length === 0 ? "—" : run.repos.join(", ")}
                </Table.Cell>
                <Table.Cell>{run.outcome ?? "running"}</Table.Cell>
                <Table.Cell class="text-muted-foreground whitespace-normal">{formatDateTime(run.createdAt)}</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </Card.Content>
    </Card.Root>
  {/if}
</div>

<Dialog.Root bind:open={editOpen}>
  <Dialog.Content>
    <form class="flex flex-col gap-4" onsubmit={submitEdit}>
      <Dialog.Header>
        <Dialog.Title>Edit memory</Dialog.Title>
        <Dialog.Description>
          The claim as agents will read it, what it is about, and who gets it. Its signals stay.
        </Dialog.Description>
      </Dialog.Header>
      <Field.FieldGroup>
        <Field.Field>
          <Field.FieldLabel for="edit-text">Claim</Field.FieldLabel>
          <Textarea id="edit-text" bind:value={editText} rows={4} required maxlength={500} />
        </Field.Field>
        <Field.Field>
          <Field.FieldLabel for="edit-kind">Kind</Field.FieldLabel>
          <Select.Root type="single" bind:value={editKind}>
            <Select.Trigger id="edit-kind" class="w-full">{editKind}</Select.Trigger>
            <Select.Content>
              <Select.Group>
                {#each memoryKindSchema.options as kind (kind)}
                  <Select.Item value={kind} label={kind} />
                {/each}
              </Select.Group>
            </Select.Content>
          </Select.Root>
        </Field.Field>
        <SubjectPicker id="edit" bind:subject={editSubject} bind:repoUrl={editRepoUrl}
          suggestions={knownRepos} />
        <Field.Field>
          <Field.FieldLabel for="edit-audience">Audience</Field.FieldLabel>
          <Select.Root type="single" bind:value={editAudience}>
            <Select.Trigger id="edit-audience" class="w-full">
              {editAudience === "all" ? "Every agent" : `Only ${agentName(editAudience)}`}
            </Select.Trigger>
            <Select.Content>
              <Select.Group>
                <Select.Item value="all" label="Every agent" />
                {#each data.agents as agent (agent.id)}
                  <Select.Item value={agent.id} label={agent.name} />
                {/each}
              </Select.Group>
            </Select.Content>
          </Select.Root>
        </Field.Field>
      </Field.FieldGroup>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => (editOpen = false)}>Cancel</Button>
        <Button type="submit" disabled={busy}>
          {#if busy}<Spinner data-icon="inline-start" />{/if}
          Save
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<AlertDialog.Root bind:open={retireOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Retire this memory?</AlertDialog.Title>
      <AlertDialog.Description>
        It leaves every future brief and search result. The record stays, so the runs it was briefed
        into keep their explanation.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Keep it</AlertDialog.Cancel>
      <AlertDialog.Action
        onclick={() => {
          retireOpen = false;
          void act("Retired", () => retireMemory(fetch, memory.id));
        }}
      >
        Retire
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
