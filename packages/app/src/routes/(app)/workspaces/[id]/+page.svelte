<script lang="ts">
import { can } from "$lib/utils/auth/capabilities";
import ObjectHeader from "$lib/components/object-header/object-header.svelte";
import { goto, invalidate } from "$app/navigation";
import type { WorkspaceRepo } from "$lib/api/types";
import {
  addWorkspaceRepo,
  archiveWorkspace,
  removeWorkspaceRepo,
  updateWorkspace,
  updateWorkspaceRepo,
} from "$lib/api/workspaces";
import EnvironmentPanel from "$lib/components/environment-panel/environment-panel.svelte";
import ForgeIcon from "$lib/components/forge-icon/forge-icon.svelte";
import SettingsSection from "$lib/components/settings-section/settings-section.svelte";
import SizeClassSelect from "$lib/components/size-class-select/size-class-select.svelte";
import * as Alert from "$lib/components/ui/alert";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Dialog from "$lib/components/ui/dialog";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select";
import { Separator } from "$lib/components/ui/separator";
import { Spinner } from "$lib/components/ui/spinner";
import { Textarea } from "$lib/components/ui/textarea";
import { ignoredDockerfiles } from "$lib/utils/environments";
import { forgeRepoLabel } from "$lib/utils/forge";
import ArchiveIcon from "@lucide/svelte/icons/archive";
import GitBranchIcon from "@lucide/svelte/icons/git-branch";
import LayersIcon from "@lucide/svelte/icons/layers";
import PencilIcon from "@lucide/svelte/icons/pencil";
import PlusIcon from "@lucide/svelte/icons/plus";
import XIcon from "@lucide/svelte/icons/x";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const ws = $derived(data.workspace);
const archived = $derived(ws.workspace.archivedAt !== null);
const canManage = $derived(ws.canManage && !archived);
const canManageResources = $derived(can(data.user, "resources:manage"));

const repoById = $derived(new Map(data.repos.map((r) => [r.id, r])));
const repoName = (id: string) => {
  const repo = repoById.get(id);
  return repo ? forgeRepoLabel(repo) : id;
};

async function save(input: Parameters<typeof updateWorkspace>[2], failure: string) {
  try {
    await updateWorkspace(fetch, ws.workspace.id, input);
    await invalidate("app:workspace");
    return true;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : failure);
    return false;
  }
}

// ---- name and description ----
let name = $derived(ws.workspace.name);
let description = $derived(ws.workspace.description ?? "");
let savingGeneral = $state(false);
const generalDirty = $derived(
  name.trim() !== ws.workspace.name || description.trim() !== (ws.workspace.description ?? ""),
);

async function saveGeneral(event: SubmitEvent) {
  event.preventDefault();
  savingGeneral = true;
  if (
    await save(
      { name: name.trim(), description: description.trim() || null },
      "Failed to save the workspace",
    )
  ) {
    toast.success("Saved");
  }
  savingGeneral = false;
}

// ---- members: one dialog for adding and editing; `editing` is null when adding ----
let memberOpen = $state(false);
let editing = $state<WorkspaceRepo | null>(null);
let memberRepoId = $state("");
let memberRef = $state("");
let memberPath = $state("");
let memberDescription = $state("");
let savingMember = $state(false);

// A repo belongs to at most one workspace, so only the ones none holds are offered.
const held = $derived(new Set(data.held));
const freeRepos = $derived(data.repos.filter((r) => !r.archivedAt && !held.has(r.id)));

function openMember(member: WorkspaceRepo | null) {
  editing = member;
  memberRepoId = member?.connectedRepoId ?? "";
  memberRef = member?.ref ?? "";
  memberPath = member?.path ?? "";
  memberDescription = member?.description ?? "";
  memberOpen = true;
}

async function submitMember(event: SubmitEvent) {
  event.preventDefault();
  if (!editing && !memberRepoId) return;
  savingMember = true;
  try {
    const fields = {
      ref: memberRef.trim() || null,
      ...(memberPath.trim() ? { path: memberPath.trim() } : {}),
      description: memberDescription.trim() || null,
    };
    if (editing) {
      await updateWorkspaceRepo(fetch, ws.workspace.id, editing.connectedRepoId, fields);
    } else {
      await addWorkspaceRepo(fetch, ws.workspace.id, { connectedRepoId: memberRepoId, ...fields });
    }
    memberOpen = false;
    await invalidate("app:workspace");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to save the repository");
  } finally {
    savingMember = false;
  }
}

let removing = $state<string | null>(null);
async function remove(member: WorkspaceRepo) {
  removing = member.connectedRepoId;
  try {
    await removeWorkspaceRepo(fetch, ws.workspace.id, member.connectedRepoId);
    await invalidate("app:workspace");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to remove the repository");
  } finally {
    removing = null;
  }
}

// ---- which member's Dockerfile defines the machine: an admin's call, like the size ----
const FIRST_MEMBER = "__first__";
const env = $derived("error" in data.environment ? null : data.environment);
const environmentRepoId = $derived(env?.environmentRepoId ?? null);

function environmentRepoLabel(id: string | null): string {
  if (id !== null) return repoName(id);
  const first = ws.repos[0];
  return first ? `First repository (${repoName(first.connectedRepoId)})` : "First repository";
}

async function changeEnvironmentRepo(value: string) {
  const next = value === FIRST_MEMBER ? null : value;
  if (next === environmentRepoId) return;
  await save({ environmentRepoId: next }, "Failed to change the environment repository");
}

async function changeSize(sizeClass: string | null) {
  if (await save({ sizeClass }, "Failed to change the size")) {
    toast.success(sizeClass === null ? "Runs use the default size" : `Runs are ${sizeClass}`);
  }
}

// ---- archive ----
let archiveOpen = $state(false);
let archiving = $state(false);

async function archive() {
  archiving = true;
  try {
    await archiveWorkspace(fetch, ws.workspace.id);
    toast.success(`Archived ${ws.workspace.name}`);
    await goto("/workspaces", { invalidateAll: true });
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to archive the workspace");
    archiving = false;
  }
}
</script>

<svelte:head>
  <title>{ws.workspace.name} · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-10">
  <ObjectHeader title={ws.workspace.name}>
    {#snippet icon()}
      <LayersIcon />
    {/snippet}
    {#if ws.workspace.description}
      <p class="text-muted-foreground text-sm">{ws.workspace.description}</p>
    {/if}
  </ObjectHeader>

  {#if archived}
    <Alert.Root>
      <ArchiveIcon />
      <Alert.Title>This workspace is archived</Alert.Title>
      <Alert.Description>New tasks can't target it. Runs that used it keep their record.</Alert.Description>
    </Alert.Root>
  {:else if !ws.canManage}
    <Alert.Root>
      <Alert.Title>You can view this workspace, but not change it</Alert.Title>
      <Alert.Description>
        Changing it takes admin access to every repository in it.
      </Alert.Description>
    </Alert.Root>
  {/if}

  {#if canManage}
    <SettingsSection
      id="general"
      title="Name and description"
      description="Agents read the description to know what these repositories are for."
    >
      <form onsubmit={saveGeneral} class="flex flex-col gap-4">
        <Field.FieldGroup>
          <Field.Field>
            <Field.FieldLabel for="ws-name">Name</Field.FieldLabel>
            <Input id="ws-name" required bind:value={name} />
          </Field.Field>
          <Field.Field>
            <Field.FieldLabel for="ws-description">Description</Field.FieldLabel>
            <Textarea id="ws-description" rows={3} bind:value={description} />
          </Field.Field>
        </Field.FieldGroup>
        <Button
          type="submit"
          class="w-fit"
          disabled={savingGeneral || !generalDirty || !name.trim()}
        >
          {#if savingGeneral}
            <Spinner data-icon="inline-start" />
          {/if}
          Save
        </Button>
      </form>
    </SettingsSection>

    <Separator />
  {/if}

  <SettingsSection
    id="repositories"
    title="Repositories"
    description="Checked out side by side, in this order, for every run on the workspace. Each repository an agent changes gets its own patch."
  >
    {#if ws.repos.length === 0}
      <p class="text-muted-foreground rounded-lg border border-dashed px-3 py-6 text-center text-sm">
        No repositories yet. Tasks on this workspace are refused until it has one.
      </p>
    {:else}
      <ul class="divide-y rounded-lg border text-sm">
        {#each ws.repos as member (member.connectedRepoId)}
          {@const repo = repoById.get(member.connectedRepoId)}
          <li class="flex items-start gap-3 px-3 py-2.5">
            {#if repo}
              <ForgeIcon provider={repo.provider} class="mt-0.5" />
            {/if}
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <span class="truncate font-medium">{repoName(member.connectedRepoId)}</span>
                <span class="text-muted-foreground font-mono text-xs">{member.path}/</span>
                <span class="text-muted-foreground flex items-center gap-1 text-xs">
                  <GitBranchIcon class="size-3" />
                  {member.ref ?? repo?.defaultBranch ?? "default branch"}
                </span>
                {#if repo?.archivedAt}
                  <Badge variant="destructive">Disconnected</Badge>
                {/if}
              </div>
              {#if member.description}
                <p class="text-muted-foreground">{member.description}</p>
              {/if}
            </div>
            {#if canManage}
              <div class="flex shrink-0 items-center">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Edit {repoName(member.connectedRepoId)}"
                  onclick={() => openMember(member)}
                >
                  <PencilIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove {repoName(member.connectedRepoId)}"
                  disabled={removing === member.connectedRepoId}
                  onclick={() => remove(member)}
                >
                  {#if removing === member.connectedRepoId}
                    <Spinner />
                  {:else}
                    <XIcon />
                  {/if}
                </Button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if canManage}
      <Button variant="outline" class="w-fit" onclick={() => openMember(null)}>
        <PlusIcon data-icon="inline-start" />
        Add repository
      </Button>
    {/if}
  </SettingsSection>

  <Separator />

  <SettingsSection id="environment" title="Environment">
    {#snippet description()}
      The image a run starts on: one repository's <code>.ryph/Dockerfile</code>, with every
      repository checked out and its <code>setup.yml</code> run in order.
    {/snippet}
    <EnvironmentPanel
      subject={{ kind: "workspace", id: ws.workspace.id }}
      environment={data.environment}
      definition={data.environmentDefinition}
      canManage={canManageResources}
    >
      {#if env !== null && env.enabled && ws.repos.length > 0}
        <Field.Field>
          <Field.FieldLabel for="environment-repo">Dockerfile from</Field.FieldLabel>
          {#if canManageResources && !archived}
            <Select.Root
              type="single"
              value={environmentRepoId ?? FIRST_MEMBER}
              onValueChange={changeEnvironmentRepo}
            >
              <Select.Trigger id="environment-repo" class="w-full sm:w-96">
                {environmentRepoLabel(environmentRepoId)}
              </Select.Trigger>
              <Select.Content>
                <Select.Group>
                  <Select.Item value={FIRST_MEMBER} label={environmentRepoLabel(null)} />
                  {#each ws.repos as member (member.connectedRepoId)}
                    <Select.Item
                      value={member.connectedRepoId}
                      label={repoName(member.connectedRepoId)}
                    />
                  {/each}
                </Select.Group>
              </Select.Content>
            </Select.Root>
          {:else}
            <p class="text-sm font-medium">{environmentRepoLabel(environmentRepoId)}</p>
          {/if}
          <!-- Which members carry a Dockerfile is the forge's answer, which the load streams:
               until it lands this says nothing rather than claiming no other member has one. -->
          {#await data.environmentDefinition then read}
            {@const ignored = ignoredDockerfiles(read)}
            {#if ignored !== null && ignored.length > 0}
              <Field.FieldDescription>
                Also has a Dockerfile, which isn't used:
                {#each ignored as file, i (file)}
                  <span class="font-mono text-xs">{file}</span>{i < ignored.length - 1 ? ", " : "."}
                {/each}
                A workspace runs on one machine.
              </Field.FieldDescription>
            {/if}
          {/await}
        </Field.Field>
      {/if}
    </EnvironmentPanel>
  </SettingsSection>

  <Separator />

  <SettingsSection
    id="size"
    title="Machine size"
    description="How much CPU, memory and disk a run on this workspace gets."
  >
    <SizeClassSelect
      value={ws.workspace.sizeClass}
      sizes={data.sizes}
      canChange={canManageResources && !archived}
      onChange={changeSize}
    />
  </SettingsSection>

  {#if canManage}
    <Separator />

    <SettingsSection
      id="archive"
      title="Archive"
      description="Its repositories stay connected and can join another workspace. This can't be undone."
    >
      <Button variant="destructive" class="w-fit" onclick={() => (archiveOpen = true)}>
        <ArchiveIcon data-icon="inline-start" />
        Archive workspace
      </Button>
    </SettingsSection>
  {/if}
</div>

<Dialog.Root bind:open={memberOpen}>
  <Dialog.Content>
    <form onsubmit={submitMember} class="flex flex-col gap-4">
      <Dialog.Header>
        <Dialog.Title>
          {editing ? `Edit ${repoName(editing.connectedRepoId)}` : "Add a repository"}
        </Dialog.Title>
        {#if !editing}
          <Dialog.Description>
            You need admin access to it and to the workspace's other repositories.
          </Dialog.Description>
        {/if}
      </Dialog.Header>
      <Field.FieldGroup>
        {#if !editing}
          <Field.Field>
            <Field.FieldLabel for="member-repo">Repository</Field.FieldLabel>
            <Select.Root type="single" bind:value={memberRepoId}>
              <Select.Trigger id="member-repo" class="w-full">
                {memberRepoId ? repoName(memberRepoId) : "Select a repository"}
              </Select.Trigger>
              <Select.Content>
                <Select.Group>
                  {#each freeRepos as repo (repo.id)}
                    <Select.Item value={repo.id} label={forgeRepoLabel(repo)}>
                      <ForgeIcon provider={repo.provider} />
                      {forgeRepoLabel(repo)}
                    </Select.Item>
                  {/each}
                </Select.Group>
              </Select.Content>
            </Select.Root>
            {#if freeRepos.length === 0}
              <Field.FieldDescription>
                Every connected repository is already in a workspace.
              </Field.FieldDescription>
            {/if}
          </Field.Field>
        {/if}
        <Field.Field>
          <Field.FieldLabel for="member-path">Directory</Field.FieldLabel>
          <Input
            id="member-path"
            bind:value={memberPath}
            placeholder={editing ? editing.path : "The repository's name"}
          />
          <Field.FieldDescription>
            Where it's checked out. Lowercase letters, digits and dashes.
          </Field.FieldDescription>
        </Field.Field>
        <Field.Field>
          <Field.FieldLabel for="member-ref">Branch or ref</Field.FieldLabel>
          <Input id="member-ref" bind:value={memberRef} placeholder="Default branch" />
        </Field.Field>
        <Field.Field>
          <Field.FieldLabel for="member-description">What it is</Field.FieldLabel>
          <Textarea
            id="member-description"
            rows={2}
            bind:value={memberDescription}
            placeholder="The API, deployed as prod-api"
          />
          <Field.FieldDescription>
            Helps an agent tell which repository an alert or a request belongs in.
          </Field.FieldDescription>
        </Field.Field>
      </Field.FieldGroup>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => (memberOpen = false)}>Cancel</Button>
        <Button type="submit" disabled={savingMember || (!editing && !memberRepoId)}>
          {#if savingMember}
            <Spinner data-icon="inline-start" />
          {/if}
          {editing ? "Save" : "Add"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<AlertDialog.Root bind:open={archiveOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Archive {ws.workspace.name}?</AlertDialog.Title>
      <AlertDialog.Description>
        Its repositories leave the workspace but stay connected. New tasks and triggers can't
        target it, and runs already started are unaffected. This can't be undone.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action disabled={archiving} onclick={archive}>
        {#if archiving}
          <Spinner data-icon="inline-start" />
        {/if}
        Archive
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
