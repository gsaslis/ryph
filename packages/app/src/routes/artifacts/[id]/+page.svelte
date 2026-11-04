<script lang="ts">
import { goto } from "$app/navigation";
import { deleteArtifact } from "$lib/api/artifacts";
import ArtifactFrame from "$lib/components/artifact-frame/artifact-frame.svelte";
import RyphLogo from "$lib/components/ryph-logo/ryph-logo.svelte";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
import * as Popover from "$lib/components/ui/popover";
import { Separator } from "$lib/components/ui/separator";
import { Spinner } from "$lib/components/ui/spinner";
import { artifactHref } from "$lib/utils/artifacts";
import { formatDateTime, formatRelativeTime } from "$lib/utils/format";
import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
import HistoryIcon from "@lucide/svelte/icons/history";
import Trash2Icon from "@lucide/svelte/icons/trash-2";
import UsersIcon from "@lucide/svelte/icons/users";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const artifact = $derived(data.artifact);
const latest = $derived(artifact.currentVersion);
const versions = $derived(artifact.versions.toSorted((a, b) => b.version - a.version));
const shown = $derived(versions.find((v) => v.version === data.version) ?? null);
const title = $derived(shown?.title ?? artifact.title);
const older = $derived(data.version !== latest);
/** Who asked for the version on screen. */
const requester = $derived(shown?.requestedBy ?? null);
const link =
  "underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground";

/** The run behind a version: a link to its task when the control plane names it. */
const runHref = (taskId: string | null | undefined) =>
  taskId ? `/tasks/${encodeURIComponent(taskId)}` : null;
const originRun = $derived(runHref(artifact.originTaskId));
const shownRun = $derived(
  shown !== null && shown.runId !== artifact.originRunId ? runHref(shown.taskId) : null,
);

/** A person as the header names them. */
const personName = (person: { name: string | null }) => person.name ?? "A former member";

function showVersion(value: string) {
  const n = Number(value);
  if (!Number.isInteger(n) || n === data.version) return;
  void goto(n === latest ? artifactHref(artifact.id) : artifactHref(artifact.id, n), {
    keepFocus: true,
    noScroll: true,
  });
}

let confirmingDelete = $state(false);
let deleting = $state(false);

async function remove() {
  deleting = true;
  try {
    await deleteArtifact(fetch, artifact.id);
    toast.success(`Deleted "${artifact.title}"`);
    confirmingDelete = false;
    await goto("/artifacts");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to delete artifact");
  } finally {
    deleting = false;
  }
}
</script>

<svelte:head>
  <title>{title} · Ryph</title>
</svelte:head>

<!-- Ryph's own bar over a page an agent made. Everything in the bar is the platform's; everything
     under it is the agent's, in a sandboxed frame that cannot read the bar or act as the viewer. -->
<div class="bg-sidebar text-sidebar-foreground flex h-dvh flex-col">
  <header class="flex h-12 shrink-0 items-center gap-1 pr-2 pl-3 sm:gap-1.5 sm:pr-3 sm:pl-4">
    <a
      href="/"
      aria-label="Ryph"
      class="focus-visible:ring-ring -ml-1 flex shrink-0 items-center rounded-md p-1 outline-none focus-visible:ring-2"
    >
      <RyphLogo mark class="size-7 sm:hidden" />
      <RyphLogo class="hidden h-5 w-auto sm:block" />
    </a>
    <Separator orientation="vertical" class="mx-1.5 data-[orientation=vertical]:h-5 sm:mx-2" />
    <h1 class="min-w-0 flex-1 truncate text-sm font-medium" {title}>{title}</h1>

    <!-- Versions, newest first; the latest is the one a plain link opens. -->
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="ghost"
            size="sm"
            class={[
              "tabular-nums",
              older && "bg-warning text-warning-foreground hover:bg-warning/85 hover:text-warning-foreground",
            ]}
            aria-label="Version {data.version} of {latest}"
          >
            <HistoryIcon data-icon="inline-start" />
            <span class="sm:hidden">v{data.version}</span>
            <span class="hidden sm:inline">
              {older ? `Version ${data.version} of ${latest}` : `Version ${data.version}`}
            </span>
            <ChevronDownIcon data-icon="inline-end" class="text-muted-foreground" />
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="w-72 max-w-[calc(100vw-2rem)]">
        <DropdownMenu.Group>
          <DropdownMenu.Label>Versions</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={String(data.version)} onValueChange={showVersion}>
            {#each versions as v (v.version)}
              <DropdownMenu.RadioItem value={String(v.version)} class="items-start py-2">
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="flex items-center gap-2">
                    <span class="font-medium tabular-nums">Version {v.version}</span>
                    {#if v.version === latest}
                      <Badge variant="secondary">Latest</Badge>
                    {/if}
                  </span>
                  <span class="text-muted-foreground truncate text-xs" title={formatDateTime(v.createdAt)}>
                    {formatRelativeTime(v.createdAt)}{#if v.requestedBy}, requested by {personName(v.requestedBy)}{/if}
                  </span>
                </span>
              </DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu.Root>

    <!-- Who can see it, who asked for it, and where it came from. -->
    <Popover.Root>
      <Popover.Trigger>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="sm" aria-label="Everyone can see this">
            <UsersIcon data-icon="inline-start" />
            <span class="hidden md:inline">Everyone</span>
            <ChevronDownIcon data-icon="inline-end" class="text-muted-foreground hidden md:block" />
          </Button>
        {/snippet}
      </Popover.Trigger>
      <Popover.Content align="end" class="w-80 max-w-[calc(100vw-2rem)] gap-3">
        <Popover.Header>
          <Popover.Title>Everyone on this instance can see this</Popover.Title>
          <Popover.Description>
            Anyone signed in here can open this page and its earlier versions.
          </Popover.Description>
        </Popover.Header>
        <Separator />
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt class="text-muted-foreground">Requested by</dt>
          <dd class="truncate">{requester === null ? "No one" : personName(requester)}</dd>
          <dt class="text-muted-foreground">Agent</dt>
          <dd class="truncate">
            {#if artifact.agent.name === null}
              A deleted agent
            {:else}
              <a href="/agents/{artifact.agent.id}/edit" class={link}>{artifact.agent.name}</a>
            {/if}
          </dd>
          <dt class="text-muted-foreground">Run</dt>
          <dd>
            {#if originRun}
              <a href={originRun} class={link}>Open the run</a>
            {:else}
              <span class="text-muted-foreground font-mono break-all">{artifact.originRunId}</span>
            {/if}
          </dd>
          {#if shownRun}
            <dt class="text-muted-foreground">This version</dt>
            <dd><a href={shownRun} class={link}>Open its run</a></dd>
          {/if}
          <dt class="text-muted-foreground">Created</dt>
          <dd title={formatDateTime(artifact.createdAt)}>{formatRelativeTime(artifact.createdAt)}</dd>
        </dl>
      </Popover.Content>
    </Popover.Root>

    {#if artifact.canDelete}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="ghost" size="icon-sm" aria-label="More actions">
              <EllipsisIcon />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          <DropdownMenu.Group>
            <DropdownMenu.Item variant="destructive" onclick={() => (confirmingDelete = true)}>
              <Trash2Icon />
              Delete artifact
            </DropdownMenu.Item>
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/if}
  </header>

  <main class="flex min-h-0 flex-1 sm:px-2 sm:pb-2">
    <ArtifactFrame
      id={artifact.id}
      version={data.version}
      {title}
      class="bg-background flex-1 border-t sm:rounded-lg sm:border"
    />
  </main>
</div>

<AlertDialog.Root bind:open={confirmingDelete}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Delete "{artifact.title}"?</AlertDialog.Title>
      <AlertDialog.Description>
        It's removed for everyone, with all its versions. Links to it stop working.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={deleting}>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action variant="destructive" disabled={deleting} onclick={remove}>
        {#if deleting}
          <Spinner data-icon="inline-start" />
        {/if}
        Delete
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
