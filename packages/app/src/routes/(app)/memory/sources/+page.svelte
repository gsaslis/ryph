<script lang="ts">
import { can } from "$lib/utils/auth/capabilities";
import PageTitle from "$lib/components/page-title/page-title.svelte";
import { invalidate } from "$app/navigation";
import { ingestMemorySource } from "$lib/api/memory";
import type { MemorySource, MemorySourceKind } from "$lib/api/types";
import { SubjectPicker } from "$lib/components/subject-picker";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Dialog from "$lib/components/ui/dialog";
import * as Empty from "$lib/components/ui/empty";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select";
import { Spinner } from "$lib/components/ui/spinner";
import * as Table from "$lib/components/ui/table";
import { Textarea } from "$lib/components/ui/textarea";
import { formatDateTime } from "$lib/utils/format";
import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
import FileTextIcon from "@lucide/svelte/icons/file-text";
import PlusIcon from "@lucide/svelte/icons/plus";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const canManage = $derived(can(data.user, "memory:manage"));

const KIND_LABEL: Record<MemorySourceKind, string> = {
  paste: "pasted",
  upload: "uploaded",
  url: "fetched from a URL",
  "repo-file": "a repository file",
};

const subjectLabel = (source: MemorySource) =>
  source.defaultSubject.kind === "org" ? "the org" : source.defaultSubject.url;

// While an extraction runs behind a source, the list follows it.
const anyIngesting = $derived(data.sources.some((s) => s.status === "ingesting"));
$effect(() => {
  if (!anyIngesting) return;
  const timer = setInterval(() => void invalidate("app:memory"), 2500);
  return () => clearInterval(timer);
});

// ── ingest ──────────────────────────────────────────────────────────────────────────────────

let open = $state(false);
let kind = $state<MemorySourceKind>("paste");
let title = $state("");
let text = $state("");
let locator = $state("");
let subject = $state("org");
let repoUrl = $state("");
let ingesting = $state(false);
let fileName = $state("");

function openIngest() {
  kind = "paste";
  title = "";
  text = "";
  locator = "";
  subject = "org";
  repoUrl = "";
  fileName = "";
  open = true;
}

async function pickFile(event: Event) {
  const file = (event.currentTarget as HTMLInputElement).files?.[0];
  if (!file) return;
  fileName = file.name;
  if (title.trim() === "") title = file.name.replace(/\.[^.]+$/, "");
  text = await file.text();
}

async function submit(event: SubmitEvent) {
  event.preventDefault();
  ingesting = true;
  try {
    const byLocator = kind === "url" || kind === "repo-file";
    const { source } = await ingestMemorySource(fetch, {
      kind,
      title: title.trim() === "" ? undefined : title.trim(),
      ...(byLocator ? { locator: locator.trim() } : { text }),
      subject: subject === "repo" ? { kind: "repo", url: repoUrl } : { kind: "org" },
    });
    toast.success(`Ingesting "${source.title}" — its review batch lands here as it is extracted`);
    open = false;
    await invalidate("app:memory");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Ingest failed");
  } finally {
    ingesting = false;
  }
}
</script>

<svelte:head>
  <title>Memory sources · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-6">
  <PageTitle title="Sources">
    {#snippet actions()}
      {#if canManage}
        <Button onclick={openIngest}>
          <PlusIcon data-icon="inline-start" />
          Ingest a document
        </Button>
      {/if}
    {/snippet}
    {#snippet description()}
      Guides, runbooks and architecture docs for agents to learn from. Each is broken into claims
      for you to review, and agents can read the whole document when they need it.
    {/snippet}
  </PageTitle>

  {#if data.sources.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon"><FileTextIcon /></Empty.Media>
        <Empty.Title>No documents yet</Empty.Title>
        <Empty.Description>
          Paste or upload what a new teammate would read first. The extractor turns it into
          claims for review; what does not fit a claim stays a document agents can pull on demand.
        </Empty.Description>
      </Empty.Header>
      {#if canManage}
        <Empty.Content>
          <Button onclick={openIngest}>
            <PlusIcon data-icon="inline-start" />
            Ingest a document
          </Button>
        </Empty.Content>
      {/if}
    </Empty.Root>
  {:else}
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Document</Table.Head>
          <Table.Head>Kind</Table.Head>
          <Table.Head>Status</Table.Head>
          <Table.Head>About</Table.Head>
          <Table.Head>Ingested</Table.Head>
          <Table.Head class="text-right">Size</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each data.sources as source (source.id)}
          <Table.Row>
            <Table.Cell class="max-w-xl">
              <a href="/memory/sources/{source.id}" class="flex flex-col gap-0.5">
                <span class="whitespace-normal font-medium">{source.title}</span>
                <span class="text-muted-foreground font-mono text-xs">
                  {source.id}
                  {#if source.locator}
                    · {source.locator}
                  {/if}
                  {#if source.supersedesSourceId}
                    · replaces {source.supersedesSourceId}
                  {/if}
                </span>
              </a>
            </Table.Cell>
            <Table.Cell><Badge variant="secondary">{KIND_LABEL[source.kind]}</Badge></Table.Cell>
            <Table.Cell>
              {#if source.status === "ingesting"}
                <span class="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
                  <Spinner class="size-3" />
                  Ingesting…
                </span>
              {:else if source.status === "failed"}
                <span class="text-destructive inline-flex items-center gap-1.5 text-xs" title={source.failure ?? undefined}>
                  <CircleAlertIcon class="size-3" />
                  Failed
                </span>
              {:else if source.extraction}
                <span class="text-muted-foreground text-xs">
                  {source.extraction.modelBacked
                    ? `${source.extraction.extracted} claims from ${source.extraction.sections} sections`
                    : "pointer only"}
                </span>
              {/if}
            </Table.Cell>
            <Table.Cell class="text-muted-foreground max-w-48 truncate">{subjectLabel(source)}</Table.Cell>
            <Table.Cell class="text-muted-foreground">{formatDateTime(source.ingestedAt)}</Table.Cell>
            <Table.Cell class="text-right font-mono text-xs">{source.chars.toLocaleString()} chars</Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  {/if}
</div>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
    <form class="flex flex-col gap-4" onsubmit={submit}>
      <Dialog.Header>
        <Dialog.Title>Ingest a document</Dialog.Title>
        <Dialog.Description>
          What comes out is a batch of proposals for you to accept, edit or reject — nothing
          reaches the canon unreviewed. Never a document with credentials in it.
        </Dialog.Description>
      </Dialog.Header>
      <Field.FieldGroup>
        <Field.Field>
          <Field.FieldLabel for="ingest-kind">From</Field.FieldLabel>
          <Select.Root type="single" bind:value={kind}>
            <Select.Trigger id="ingest-kind" class="w-full">
              {kind === "paste"
                ? "Pasted text"
                : kind === "upload"
                ? "A file"
                : kind === "url"
                ? "A URL"
                : "A repository file"}
            </Select.Trigger>
            <Select.Content>
              <Select.Group>
                <Select.Item value="paste" label="Pasted text" />
                <Select.Item value="upload" label="A file (markdown or text)" />
                <Select.Item value="url" label="A URL" />
                <Select.Item value="repo-file" label="A repository file (public GitHub or GitLab)" />
              </Select.Group>
            </Select.Content>
          </Select.Root>
        </Field.Field>
        {#if kind === "url" || kind === "repo-file"}
          <Field.Field>
            <Field.FieldLabel for="ingest-locator">
              {kind === "url" ? "URL" : "Repository file"}
            </Field.FieldLabel>
            <Input
              id="ingest-locator"
              required
              bind:value={locator}
              placeholder={kind === "url"
                ? "https://docs.example.com/onboarding"
                : "https://github.com/acme/app@main:docs/setup.md"}
            />
            <Field.FieldDescription>
              {#if kind === "url"}
                Fetched by the memory service: https, public addresses only, redirects not
                followed.
              {:else}
                As <code>&lt;repo url&gt;@&lt;ref&gt;:&lt;path&gt;</code>. Read over HTTPS from
                github.com or GitLab, so public repositories only — paste or upload a private
                one's file.
              {/if}
            </Field.FieldDescription>
          </Field.Field>
        {:else if kind === "upload"}
          <Field.Field>
            <Field.FieldLabel for="ingest-file">File</Field.FieldLabel>
            <Input id="ingest-file" type="file" accept=".md,.markdown,.txt,text/*" onchange={pickFile} />
            {#if fileName}
              <Field.FieldDescription>{fileName}: {text.length.toLocaleString()} characters</Field.FieldDescription>
            {/if}
          </Field.Field>
        {:else}
          <Field.Field>
            <Field.FieldLabel for="ingest-text">Text</Field.FieldLabel>
            <Textarea id="ingest-text" rows={10} required bind:value={text} placeholder="# Onboarding …" />
          </Field.Field>
        {/if}
        <Field.Field>
          <Field.FieldLabel for="ingest-title">Title</Field.FieldLabel>
          <Input
            id="ingest-title"
            bind:value={title}
            required={kind === "paste" || kind === "upload"}
            placeholder="Onboarding guide"
          />
          <Field.FieldDescription>
            Ingesting the same title (or URL) again supersedes the earlier version.
          </Field.FieldDescription>
        </Field.Field>
        <SubjectPicker id="ingest" bind:subject bind:repoUrl />
      </Field.FieldGroup>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
        <Button type="submit" disabled={ingesting || (kind === "upload" && text === "")}>
          {#if ingesting}
            <Spinner data-icon="inline-start" />
          {:else}
            <PlusIcon data-icon="inline-start" />
          {/if}
          Ingest
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
