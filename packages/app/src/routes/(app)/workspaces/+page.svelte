<script lang="ts">
import PageTitle from "$lib/components/page-title/page-title.svelte";
import { goto } from "$app/navigation";
import { createWorkspace } from "$lib/api/workspaces";
import ForgeIcon from "$lib/components/forge-icon/forge-icon.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Card from "$lib/components/ui/card";
import * as Dialog from "$lib/components/ui/dialog";
import * as Empty from "$lib/components/ui/empty";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Spinner } from "$lib/components/ui/spinner";
import { Textarea } from "$lib/components/ui/textarea";
import LayersIcon from "@lucide/svelte/icons/layers";
import PlusIcon from "@lucide/svelte/icons/plus";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const repoById = $derived(new Map(data.repos.map((r) => [r.id, r])));

let createOpen = $state(false);
let creating = $state(false);
let newName = $state("");
let newDescription = $state("");

async function submitCreate(event: SubmitEvent) {
  event.preventDefault();
  creating = true;
  try {
    const created = await createWorkspace(fetch, {
      name: newName.trim(),
      ...(newDescription.trim() ? { description: newDescription.trim() } : {}),
    });
    createOpen = false;
    newName = "";
    newDescription = "";
    // Straight into it: an empty workspace's next step is adding its repositories, which is
    // what its page is for.
    await goto(`/workspaces/${created.workspace.id}`, { invalidateAll: true });
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to create the workspace");
  } finally {
    creating = false;
  }
}
</script>

<svelte:head>
  <title>Workspaces · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-6">
  <PageTitle title="Workspaces">
    {#snippet description()}
      Repositories that belong together. A run on a workspace checks out all of them.
    {/snippet}
  </PageTitle>

  {#if data.workspaces.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon">
          <LayersIcon />
        </Empty.Media>
        <Empty.Title>No workspaces yet</Empty.Title>
        <Empty.Description>
          Group a backend with its frontend, or the services an alert might touch, so one run can
          work across them.
        </Empty.Description>
      </Empty.Header>
      <Empty.Content>
        <Button onclick={() => (createOpen = true)}>
          <PlusIcon data-icon="inline-start" />
          New workspace
        </Button>
      </Empty.Content>
    </Empty.Root>
  {:else}
    <!-- Cards, as repos and agents are; the whole card opens the workspace's settings. -->
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {#each data.workspaces as ws (ws.workspace.id)}
        <Card.Root
          size="sm"
          class="@container/card from-foreground/5 to-card relative bg-linear-to-t transition-shadow hover:ring-foreground/25 has-[a:focus-visible]:ring-ring/50 has-[a:focus-visible]:ring-[3px]"
        >
          <Card.Header>
            <div class="flex min-w-0 flex-col gap-4">
              <div
                class="bg-background ring-border flex size-12 shrink-0 items-center justify-center rounded-lg ring-1"
              >
                <LayersIcon class="text-muted-foreground size-6" />
              </div>
              <Card.Title class="truncate">
                <a
                  href="/workspaces/{ws.workspace.id}"
                  class="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
                  title={ws.workspace.name}
                >
                  {ws.workspace.name}
                </a>
              </Card.Title>
            </div>
            <Card.Action>
              <Badge variant="secondary">
                {ws.repos.length}
                {ws.repos.length === 1 ? "repo" : "repos"}
              </Badge>
            </Card.Action>
          </Card.Header>
          <Card.Content class="mt-auto flex flex-col gap-2">
            {#if ws.workspace.description}
              <Card.Description class="line-clamp-2">{ws.workspace.description}</Card.Description>
            {/if}
            {#if ws.repos.length === 0}
              <Card.Description class="text-xs">No repositories yet.</Card.Description>
            {:else}
              <!-- The members by their checkout directory, which is how a run addresses them. -->
              <ul class="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
                {#each ws.repos as member (member.connectedRepoId)}
                  {@const repo = repoById.get(member.connectedRepoId)}
                  <li class="flex min-w-0 items-center gap-1">
                    {#if repo}
                      <ForgeIcon provider={repo.provider} class="size-3.5" />
                    {/if}
                    <span class="truncate">{member.path}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </Card.Content>
        </Card.Root>
      {/each}
      <button
        type="button"
        onclick={() => (createOpen = true)}
        class="text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:ring-ring/50 flex min-h-40 items-center justify-center gap-2 rounded-xl border border-dashed text-sm transition-colors outline-none focus-visible:ring-[3px]"
      >
        <PlusIcon class="size-4" />
        New workspace
      </button>
    </div>
  {/if}
</div>

<Dialog.Root bind:open={createOpen}>
  <Dialog.Content>
    <form onsubmit={submitCreate} class="flex flex-col gap-4">
      <Dialog.Header>
        <Dialog.Title>New workspace</Dialog.Title>
        <Dialog.Description>
          You'll add its repositories next. Agents read the description to know what the
          repositories are for.
        </Dialog.Description>
      </Dialog.Header>
      <Field.FieldGroup>
        <Field.Field>
          <Field.FieldLabel for="ws-name">Name</Field.FieldLabel>
          <Input id="ws-name" required bind:value={newName} placeholder="Shop" />
        </Field.Field>
        <Field.Field>
          <Field.FieldLabel for="ws-description">Description</Field.FieldLabel>
          <Textarea
            id="ws-description"
            rows={2}
            bind:value={newDescription}
            placeholder="The storefront and its API"
          />
        </Field.Field>
      </Field.FieldGroup>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => (createOpen = false)}>Cancel</Button>
        <Button type="submit" disabled={creating || !newName.trim()}>
          {#if creating}
            <Spinner data-icon="inline-start" />
          {/if}
          Create
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
