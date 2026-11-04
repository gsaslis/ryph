<script lang="ts">
import { type ConnectedRepo, type ForgeWhere, type Harness, MAX_FORGE_CAP } from "$lib/api/types";
import * as Alert from "$lib/components/ui/alert";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Checkbox } from "$lib/components/ui/checkbox";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Label } from "$lib/components/ui/label";
import * as Select from "$lib/components/ui/select";
import * as ToggleGroup from "$lib/components/ui/toggle-group";
import ForgeRepoLabel from "$lib/components/forge-repo-label/forge-repo-label.svelte";
import TagInput from "$lib/components/tag-input/tag-input.svelte";
import InfoIcon from "@lucide/svelte/icons/info";
import {
  composeForgePolicy,
  type ForgeFields,
  forgePolicyToFields,
  type ForgeToolsState,
  parseLabels,
} from "./forge-policy";
import ToggleRow from "$lib/components/toggle-row/toggle-row.svelte";

let {
  fields = $bindable(),
  connectedRepos,
  forgeState,
  offered = true,
  harness,
  canGrant,
}: {
  /** Every capability's tick and settings; granting nothing saves as no forge tools. */
  fields: ForgeFields;
  connectedRepos: ConnectedRepo[];
  /** Whether this deployment serves the forge's tools, as far as the form can tell. */
  forgeState: ForgeToolsState;
  /** Whether any way in here has issues or change requests; false where every repository is on
   * this machine. The section is then left out, unless the agent already holds access to remove. */
  offered?: boolean;
  /** The chosen harness, when the deployment's image map knows it; undefined in manual dev. */
  harness: Harness | undefined;
  /** Whether this user may grant forge tools: an admin's call, as tool access is. Removing them is
   * anyone's. */
  canGrant: boolean;
} = $props();

const WHERE_LABEL: Record<ForgeWhere, string> = {
  origin: "The run's own thread",
  any: "Any thread of the repositories above",
};

const granted = $derived(composeForgePolicy(fields) !== null);
const harnessCanUseTools = $derived(harness === undefined || harness.tools);
const editable = $derived(forgeState === "on" && harnessCanUseTools && canGrant);

// The repos the list offers: every connected one, plus any listed repo since disconnected —
// flagged, so it can be unticked knowingly rather than vanishing from the form and the save. A
// repo on this machine has no issues or change requests, so it is offered only if already listed.
const repoRows = $derived(
  connectedRepos.filter((r) =>
    (r.archivedAt === null && r.provider !== "local") || fields.connectedRepoIds.includes(r.id)
  ),
);
// Connected repos on this machine are left out of the list above, so an empty list is not always
// "nothing connected".
const hasLocalRepos = $derived(
  connectedRepos.some((r) => r.archivedAt === null && r.provider === "local"),
);
const unresolvedRepoIds = $derived(
  fields.connectedRepoIds.filter((id) => !connectedRepos.some((r) => r.id === id)),
);

// A harness that cannot use tools must not keep forge tools: the orchestrator would refuse the
// save. With the forge's state unknown nothing is cleared — "cannot be shown" is not "removed".
$effect(() => {
  if (forgeState === "on" && !harnessCanUseTools && granted) fields = forgePolicyToFields(null);
});

function remove() {
  fields = forgePolicyToFields(null);
}

function setListed(id: string, on: boolean) {
  const rest = fields.connectedRepoIds.filter((r) => r !== id);
  fields.connectedRepoIds = on ? [...rest, id] : rest;
}
</script>

<!-- The terms of a write that has them: where it may land, and how often per run. Side by side,
     under the row that grants it. -->
{#snippet terms(kind: "comment" | "review" | "closeIssues")}
  {@const whereKey = (`${kind}Where`) as "commentWhere" | "reviewWhere" | "closeIssuesWhere"}
  {@const maxKey = (`${kind}Max`) as "commentMax" | "reviewMax" | "closeIssuesMax"}
  <div class="grid gap-3 sm:grid-cols-[1fr_8rem]">
  <Field.Field>
    <Field.FieldLabel for="forge-{kind}-where" class="text-xs">Where</Field.FieldLabel>
    <Select.Root
      type="single"
      disabled={!editable}
      value={fields[whereKey]}
      onValueChange={(value) => {
          fields[whereKey] = value === "any" ? "any" : "origin";
        }}
    >
      <Select.Trigger id="forge-{kind}-where" size="sm" class="w-full">
          {WHERE_LABEL[fields[whereKey]]}
        </Select.Trigger>
      <Select.Content>
        <Select.Group>
          <Select.Item value="origin" label={WHERE_LABEL.origin} />
          <Select.Item value="any" label={WHERE_LABEL.any} />
        </Select.Group>
      </Select.Content>
    </Select.Root>
    <Field.FieldDescription class="text-xs">
        {fields[whereKey] === "origin"
          ? "The issue or change request the run was started from, and issues it opened itself."
          : kind === "closeIssues"
          ? "Any issue of the repositories chosen above."
          : "Any issue or change request of the repositories chosen above."}
      </Field.FieldDescription>
  </Field.Field>
  <Field.Field>
    <Field.FieldLabel for="forge-{kind}-max" class="text-xs">Per run, at most</Field.FieldLabel>
    <Input
      id="forge-{kind}-max"
      type="number"
      min="1"
      max={MAX_FORGE_CAP}
      step="1"
      class="h-8"
      disabled={!editable}
      bind:value={fields[maxKey]}
    />
  </Field.Field>
</div>
{/snippet}

{#if offered || granted}
<Field.FieldSet>
  <Field.FieldLegend>Issues and change requests</Field.FieldLegend>
  <Field.FieldDescription>
    Configure the agent's forge-related capabilities. Agents interact with forges through Ryph's forge gateway,
    which enforces strict permissions with run-scoped tokens.
  </Field.FieldDescription>
  {#if forgeState === "unknown"}
    <Alert.Root>
      <InfoIcon />
      <Alert.Title>Cannot be shown right now</Alert.Title>
      <Alert.Description>
        The tool gateway did not answer, so this access cannot be read or changed. Everything
        else saves as usual, and it is left as it stands.
      </Alert.Description>
    </Alert.Root>
  {:else if forgeState === "off"}
    <Alert.Root>
      <InfoIcon />
      <Alert.Title>Not served by this deployment</Alert.Title>
      <Alert.Description>
        {#if granted}
          This agent has access that no longer exists here, and new runs refuse to start with it.
          Set <code>RYPH_FORGE_TOOLS_URL</code> and <code>RYPH_FORGE_GATEWAY_TOKEN</code> on the
          gateway to restore it, or remove it.
        {:else}
          Set <code>RYPH_FORGE_TOOLS_URL</code> and <code>RYPH_FORGE_GATEWAY_TOKEN</code> on the
          gateway to offer issue and change request tools.
        {/if}
      </Alert.Description>
      {#if granted}
        <Alert.Action>
          <Button type="button" variant="outline" size="sm" onclick={remove}>Remove</Button>
        </Alert.Action>
      {/if}
    </Alert.Root>
  {:else if !harnessCanUseTools}
    <Field.FieldDescription>
      The "{harness?.kind}" harness cannot use tools, so none are offered.
    </Field.FieldDescription>
  {:else}
    {#if !canGrant}
      <Alert.Root>
        <InfoIcon />
        <Alert.Title>An administrator's call</Alert.Title>
        <Alert.Description>
          Granting these needs an administrator.
          {granted ? "Removing them can be done by anyone." : ""}
        </Alert.Description>
        {#if granted}
          <Alert.Action>
            <Button type="button" variant="outline" size="sm" onclick={remove}>Remove</Button>
          </Alert.Action>
        {/if}
      </Alert.Root>
    {/if}

    <Field.FieldGroup>
      <!-- Scope first: which repositories the permissions below apply to. Two ways, one control. -->
      <Field.Field>
        <Field.FieldLabel for="forge-repos">Repositories</Field.FieldLabel>
        <ToggleGroup.Root
          type="single"
          variant="outline"
          disabled={!editable}
          value={fields.repoMode}
          onValueChange={(value) => {
            // The group lets its one item be unpicked; the mode cannot be.
            if (value === "list" || value === "run") fields.repoMode = value;
          }}
          class="w-fit"
        >
          <ToggleGroup.Item value="run" id="forge-repos">Checked out repos</ToggleGroup.Item>
          <ToggleGroup.Item value="list">Chosen repositories</ToggleGroup.Item>
        </ToggleGroup.Root>
        <Field.FieldDescription>
          {fields.repoMode === "run"
            ? "The connected repositories a run checks out."
            : "These connected repositories, whether or not a run checks them out."}
        </Field.FieldDescription>
      </Field.Field>
      {#if fields.repoMode === "list"}
        <div class="divide-y rounded-lg border">
          {#each repoRows as repo (repo.id)}
            <div class="flex items-center gap-3 px-4 py-2.5">
              <Checkbox
                id="forge-repo-{repo.id}"
                disabled={!editable}
                checked={fields.connectedRepoIds.includes(repo.id)}
                onCheckedChange={(checked) => setListed(repo.id, checked === true)}
              />
              <Label for="forge-repo-{repo.id}" class="flex items-center gap-2">
                <ForgeRepoLabel repoRef={repo.repoRef} provider={repo.provider} />
                {#if repo.archivedAt}
                  <Badge variant="destructive">Disconnected</Badge>
                {/if}
              </Label>
            </div>
          {:else}
            <p class="text-muted-foreground px-4 py-3 text-sm">
              {#if hasLocalRepos}
                None of the connected repositories have issues or change requests.
              {:else}
                No repositories connected yet. Connect one under
                <a href="/repos" class="underline underline-offset-4">Repos</a>.
              {/if}
            </p>
          {/each}
          {#each unresolvedRepoIds as id (id)}
            <div class="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span class="font-mono">{id}</span>
              <span class="text-muted-foreground flex-1">no connected repository with this id</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!editable}
                onclick={() => setListed(id, false)}
              >
                Remove
              </Button>
            </div>
          {/each}
        </div>
      {/if}

      <!-- The permissions, one row each. A row that is on shows its terms beneath it. -->
      <div class="divide-y rounded-lg border">
        <ToggleRow
          id="forge-read"
          label="Read issues and change requests"
          description="Allow listing issues and change requests (pull requests, merge requests, patches), including comments."
          disabled={!editable}
          bind:checked={fields.read}
        />
        <ToggleRow
          id="forge-create-issues"
          label="Open issues"
          description="Allow opening issues on the repositories chosen above."
          disabled={!editable}
          bind:checked={fields.createIssues}
        >
          <Field.Field class="sm:w-32">
            <Field.FieldLabel for="forge-create-issues-max" class="text-xs">
              Per run, at most
            </Field.FieldLabel>
            <Input
              id="forge-create-issues-max"
              type="number"
              min="1"
              max={MAX_FORGE_CAP}
              step="1"
              class="h-8"
              disabled={!editable}
              bind:value={fields.createIssuesMax}
            />
          </Field.Field>
        </ToggleRow>
        <ToggleRow
          id="forge-comment"
          label="Comment"
          description="Allow commenting on any issue or change request in the repositories chosen above."
          disabled={!editable}
          bind:checked={fields.comment}
        >
          {@render terms("comment")}
        </ToggleRow>
        <ToggleRow
          id="forge-review"
          label="Review change requests"
          description="Comment-only reviews: never an approval, never a request for changes."
          disabled={!editable}
          bind:checked={fields.review}
        >
          {@render terms("review")}
        </ToggleRow>
        <ToggleRow
          id="forge-closeIssues"
          label="Close issues"
          description="Issues only, never a change request."
          disabled={!editable}
          bind:checked={fields.closeIssues}
        >
          {@render terms("closeIssues")}
        </ToggleRow>
      </div>

      <Field.Field>
        <Field.FieldLabel for="forge-labels">Labels it may apply</Field.FieldLabel>
        <!-- Chips over the policy's comma-separated string: the bridge and the orchestrator keep
             reading and counting it exactly as before. -->
        <TagInput
          id="forge-labels"
          disabled={!editable}
          placeholder="Type a label and press Enter"
          bind:tags={() => parseLabels(fields.labels), (tags) => {
            fields.labels = tags.join(", ");
          }}
        />
        <Field.FieldDescription>
          Each must already exist on the repository. Added to issues it opens and to any thread
          of the repositories chosen above, never removed. None means no labelling.
        </Field.FieldDescription>
      </Field.Field>
    </Field.FieldGroup>
  {/if}
</Field.FieldSet>
{/if}
