<script lang="ts">
import type { Agent, ConnectedRepo, WorkspaceWithRepos } from "$lib/api/types";
import { Badge } from "$lib/components/ui/badge";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select";
import * as ToggleGroup from "$lib/components/ui/toggle-group";
import { forgeRepoLabel } from "$lib/utils/forge";
import type { TargetFields } from "./automation-steps";

// The agent step: who every fire runs as, and what the run checks out. Only live agents and
// repositories are offered; an archived one a saved automation still names is shown as what it
// is, so the operator sees why fires fail, and is not silently swapped for another.
let {
  fields = $bindable(),
  agents,
  repos,
  workspaces,
}: {
  fields: TargetFields;
  /** Every agent the page knows, archived ones included. */
  agents: Agent[];
  /** Every connected repository, archived ones included. */
  repos: ConnectedRepo[];
  /** The live workspaces with at least one repository. */
  workspaces: WorkspaceWithRepos[];
} = $props();

const liveAgents = $derived(agents.filter((a) => a.archivedAt === null));
const liveRepos = $derived(repos.filter((r) => r.archivedAt === null));
const agent = $derived(agents.find((a) => a.id === fields.agentId));
const repo = $derived(repos.find((r) => r.id === fields.connectedRepoId));
const workspace = $derived(workspaces.find((w) => w.workspace.id === fields.workspaceId));

const agentLabel = $derived(
  agent === undefined
    ? fields.agentId === "" ? "Pick an agent" : `${fields.agentId} (no longer exists)`
    : agent.archivedAt === null
    ? agent.name
    : `${agent.name} (archived)`,
);
const repoLabel = $derived(
  repo === undefined
    ? fields.connectedRepoId === "" ? "Pick a repository" : fields.connectedRepoId
    : repo.archivedAt === null
    ? forgeRepoLabel(repo)
    : `${forgeRepoLabel(repo)} (disconnected)`,
);
const workspaceLabel = $derived(
  workspace?.workspace.name ??
    (fields.workspaceId === "" ? "Pick a workspace" : fields.workspaceId),
);
</script>

<Field.FieldGroup>
  <Field.Field>
    <Field.FieldLabel for="agent">Agent</Field.FieldLabel>
    <Select.Root type="single" bind:value={fields.agentId}>
      <Select.Trigger id="agent" class="w-full">{agentLabel}</Select.Trigger>
      <Select.Content>
        <Select.Group>
          {#each liveAgents as a (a.id)}
            <Select.Item value={a.id} label={a.name} />
          {/each}
        </Select.Group>
      </Select.Content>
    </Select.Root>
    <Field.FieldDescription>
      {#if liveAgents.length === 0}
        No live agents yet — <a href="/agents/create" class="underline">create one</a> before this
        automation can fire.
      {:else}
        Looked up fresh on every fire, so a change here takes the next one. A response already
        open keeps the agent it opened with.
      {/if}
    </Field.FieldDescription>
  </Field.Field>

  <Field.Field>
    <Field.FieldLabel for="target-kind">Checks out</Field.FieldLabel>
    <ToggleGroup.Root
      type="single"
      variant="outline"
      value={fields.kind}
      onValueChange={(value) => {
        if (value === "repo" || value === "workspace") fields.kind = value;
      }}
      class="w-fit"
    >
      <ToggleGroup.Item value="repo" id="target-kind">One repository</ToggleGroup.Item>
      <ToggleGroup.Item value="workspace" disabled={workspaces.length === 0}>
        A workspace
      </ToggleGroup.Item>
    </ToggleGroup.Root>
    <Field.FieldDescription>
      {fields.kind === "repo"
        ? "The run works in this one repository."
        : "The run holds every repository in the workspace and decides which it is about — for a fire whose payload does not say."}
      Your access to each repository is checked live on every fire, against your linked identity
      on its forge.
    </Field.FieldDescription>
  </Field.Field>

  {#if fields.kind === "workspace"}
    <Field.Field>
      <Field.FieldLabel for="workspace">Workspace</Field.FieldLabel>
      <Select.Root type="single" bind:value={fields.workspaceId}>
        <Select.Trigger id="workspace" class="w-full">{workspaceLabel}</Select.Trigger>
        <Select.Content>
          <Select.Group>
            {#each workspaces as w (w.workspace.id)}
              <Select.Item
                value={w.workspace.id}
                label="{w.workspace.name} · {w.repos.length} {w.repos.length === 1
                  ? 'repository'
                  : 'repositories'}"
              />
            {/each}
          </Select.Group>
        </Select.Content>
      </Select.Root>
      <Field.FieldDescription>
        Resolved at fire time: a repository added to the workspace later is in the next run.
      </Field.FieldDescription>
    </Field.Field>
  {:else}
    <div class="grid gap-6 sm:grid-cols-[2fr_1fr]">
      <Field.Field>
        <Field.FieldLabel for="repo">Repository</Field.FieldLabel>
        <Select.Root type="single" bind:value={fields.connectedRepoId}>
          <Select.Trigger id="repo" class="w-full">
            <span class="truncate">{repoLabel}</span>
          </Select.Trigger>
          <Select.Content>
            <Select.Group>
              {#each liveRepos as r (r.id)}
                <Select.Item value={r.id} label={forgeRepoLabel(r)} />
              {/each}
            </Select.Group>
          </Select.Content>
        </Select.Root>
        {#if repo !== undefined && repo.archivedAt !== null}
          <Field.FieldDescription>
            <Badge variant="destructive">Disconnected</Badge> — fires fail until another is
            picked.
          </Field.FieldDescription>
        {:else if liveRepos.length === 0}
          <Field.FieldDescription>
            No connected repositories yet — <a href="/repos/connect" class="underline"
            >connect one</a>.
          </Field.FieldDescription>
        {/if}
      </Field.Field>
      <Field.Field>
        <Field.FieldLabel for="ref">Branch</Field.FieldLabel>
        <Input
          id="ref"
          bind:value={fields.ref}
          placeholder={repo?.defaultBranch ?? "default branch"}
          class="font-mono"
        />
        <Field.FieldDescription>Or any ref. Empty for the default branch.</Field.FieldDescription>
      </Field.Field>
    </div>
  {/if}
</Field.FieldGroup>
