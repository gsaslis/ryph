<script lang="ts">
import type { TargetFields } from "$lib/api/command-rooms";
import type { ConnectedRepo, WorkspaceWithRepos } from "$lib/api/types";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select";
import { forgeRepoLabel } from "$lib/utils/forge";

let {
  fields = $bindable(),
  repos,
  workspaces,
  id,
  noneLabel = null,
}: {
  fields: TargetFields;
  repos: ConnectedRepo[];
  workspaces: WorkspaceWithRepos[];
  /** Prefixes every control's id, so several of these can share a form. */
  id: string;
  /** Offers "no target" under this label; null leaves it out (a channel row always has one). */
  noneLabel?: string | null;
} = $props();

const KIND_LABEL = {
  repo: "A repository",
  workspace: "A workspace",
} as const;

const kindLabel = $derived(fields.kind === "none" ? (noneLabel ?? "") : KIND_LABEL[fields.kind]);
const repoLabel = $derived.by(() => {
  const repo = repos.find((r) => r.id === fields.connectedRepoId);
  return repo ? forgeRepoLabel(repo) : "Select a repository";
});
const workspaceLabel = $derived(
  workspaces.find((w) => w.workspace.id === fields.workspaceId)?.workspace.name ??
    "Select a workspace",
);
</script>

<div class="flex flex-col gap-3">
  <Select.Root
    type="single"
    value={fields.kind}
    onValueChange={(value) => {
      fields.kind = value as TargetFields["kind"];
    }}
  >
    <Select.Trigger id="{id}-kind" class="w-full">{kindLabel}</Select.Trigger>
    <Select.Content>
      <Select.Group>
        {#if noneLabel !== null}
          <Select.Item value="none" label={noneLabel} />
        {/if}
        <Select.Item value="repo" label={KIND_LABEL.repo} />
        <Select.Item
          value="workspace"
          label={KIND_LABEL.workspace}
          disabled={workspaces.length === 0}
        />
      </Select.Group>
    </Select.Content>
  </Select.Root>

  {#if fields.kind === "workspace"}
    <Select.Root type="single" bind:value={fields.workspaceId}>
      <Select.Trigger id="{id}-workspace" class="w-full" aria-label="Workspace">
        {workspaceLabel}
      </Select.Trigger>
      <Select.Content>
        <Select.Group>
          {#each workspaces as ws (ws.workspace.id)}
            <Select.Item value={ws.workspace.id} label={ws.workspace.name} />
          {/each}
        </Select.Group>
      </Select.Content>
    </Select.Root>
  {:else if fields.kind === "repo"}
    <Select.Root type="single" bind:value={fields.connectedRepoId}>
      <Select.Trigger id="{id}-repo" class="w-full" aria-label="Repository">
        {repoLabel}
      </Select.Trigger>
      <Select.Content>
        <Select.Group>
          {#each repos as repo (repo.id)}
            <Select.Item value={repo.id} label={forgeRepoLabel(repo)} />
          {/each}
        </Select.Group>
      </Select.Content>
    </Select.Root>
    <Field.Field>
      <Field.FieldLabel for="{id}-ref">Branch or ref</Field.FieldLabel>
      <Input id="{id}-ref" bind:value={fields.ref} placeholder="leave empty for the default branch" />
    </Field.Field>
  {/if}
</div>
