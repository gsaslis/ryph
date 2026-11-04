<script lang="ts">
import { connectOrgSkillsRepo, type SyncedOverview } from "$lib/api/skills";
import type { ConnectedRepo } from "$lib/api/types";
import ForgeIcon from "$lib/components/forge-icon/forge-icon.svelte";
import { Button } from "$lib/components/ui/button";
import * as Dialog from "$lib/components/ui/dialog";
import * as Empty from "$lib/components/ui/empty";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select";
import { Spinner } from "$lib/components/ui/spinner";
import { forgeRepoLabel } from "$lib/utils/forge";
import { syncAnswerMessage } from "$lib/utils/skills";
import FolderGit2Icon from "@lucide/svelte/icons/folder-git-2";
import { toast } from "svelte-sonner";

let {
  repos,
  repoId = null,
  branch = null,
  submitLabel = "Connect",
  onconnected,
  oncancel,
}: {
  /** The deployment's connected repos; archived ones are left out of the picker. */
  repos: ConnectedRepo[];
  /** What is picked now, when a repo is already the org skills repo. */
  repoId?: string | null;
  branch?: string | null;
  submitLabel?: string;
  /** Told of the answer once the repo is picked and read. */
  onconnected: (answer: SyncedOverview) => void;
  /** Set when the form sits in a dialog: its actions go in the dialog's footer, with a Cancel. */
  oncancel?: () => void;
} = $props();

const live = $derived(repos.filter((r) => r.archivedAt === null));
// Seeded once from what is picked now; the form diverges from there as the admin edits it.
// svelte-ignore state_referenced_locally
let pickedId = $state(repoId ?? "");
// svelte-ignore state_referenced_locally
let typedBranch = $state(branch ?? "");
let connecting = $state(false);
const picked = $derived(live.find((r) => r.id === pickedId));

// The branch seeded from the current repo is that repo's. Picking another clears it, so the new
// one is read at its default branch unless the admin types one; picking the current repo again
// brings it back.
function pick(id: string) {
  typedBranch = id === repoId ? branch ?? "" : "";
}

async function submit(event: SubmitEvent) {
  event.preventDefault();
  if (!picked) {
    toast.error("Pick a repository");
    return;
  }
  connecting = true;
  try {
    const answer = await connectOrgSkillsRepo(fetch, {
      connectedRepoId: picked.id,
      branch: typedBranch.trim() === "" ? null : typedBranch.trim(),
    });
    const said = syncAnswerMessage(answer.sync);
    if (said.tone === "error") toast.error(`Connected, but the first sync failed. ${said.message}`);
    else toast.success(`Connected ${forgeRepoLabel(picked)}`);
    onconnected(answer);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Couldn't connect the repository");
  } finally {
    connecting = false;
  }
}
</script>

{#if live.length === 0}
  <Empty.Root class="border border-dashed py-8">
  <Empty.Header>
    <Empty.Media variant="icon">
      <FolderGit2Icon />
    </Empty.Media>
    <Empty.Title>No repositories connected</Empty.Title>
    <Empty.Description>Connect the repository that holds your skills to Ryph first.</Empty.Description>
  </Empty.Header>
  <Empty.Content>
    <Button variant="outline" size="sm" href="/repos/connect">Connect a repository</Button>
  </Empty.Content>
</Empty.Root>
{:else}
  <!-- On the page the form is framed as a box of its own; in a dialog the dialog is its frame. The
       empty state above has its own dashed frame, so the page puts no box around this component. -->
  <form class={["flex flex-col gap-4", !oncancel && "rounded-lg border p-4"]} onsubmit={submit}>
  <!-- Picking a repository trusts whoever can push to it, the first time and on every change. -->
  <p class="text-sm">
    Anyone who can push to this repository can change what your agents do. Keep write access to
    people you trust.
  </p>
  <Field.FieldGroup>
    <Field.Field>
      <Field.FieldLabel for="skills-repo">Repository</Field.FieldLabel>
      <Select.Root type="single" bind:value={pickedId} onValueChange={pick}>
        <Select.Trigger id="skills-repo" class="w-full max-w-md">
            {#if picked}
              <span class="flex min-w-0 items-center gap-2">
                <ForgeIcon provider={picked.provider} />
                <span class="truncate">{forgeRepoLabel(picked)}</span>
              </span>
            {:else}
              Pick a repository
            {/if}
          </Select.Trigger>
        <Select.Content>
          <Select.Group>
              {#each live as repo (repo.id)}
                <Select.Item value={repo.id} label={forgeRepoLabel(repo)}>
                  <ForgeIcon provider={repo.provider} />
                  <span class="truncate">{forgeRepoLabel(repo)}</span>
                </Select.Item>
              {/each}
            </Select.Group>
        </Select.Content>
      </Select.Root>
      <Field.FieldDescription>
          Not listed? <a href="/repos/connect" class="underline underline-offset-4">Connect it</a>
          first.
        </Field.FieldDescription>
    </Field.Field>
    <Field.Field>
      <Field.FieldLabel for="skills-branch">Branch</Field.FieldLabel>
      <Input
        id="skills-branch"
        class="max-w-md font-mono"
        bind:value={typedBranch}
        placeholder={picked?.defaultBranch ?? "Default branch"}
        autocomplete="off"
        spellcheck={false}
      />
      <Field.FieldDescription>
          Leave empty for the default branch. Any other branch syncs every hour and when you press
          Sync now.
        </Field.FieldDescription>
    </Field.Field>
  </Field.FieldGroup>
  {#if oncancel}
    <Dialog.Footer>
      <Button type="button" variant="ghost" onclick={oncancel}>Cancel</Button>
      {@render submitButton()}
    </Dialog.Footer>
  {:else}
    <div>
      {@render submitButton()}
    </div>
  {/if}
</form>
{/if}

{#snippet submitButton()}
  <Button type="submit" disabled={connecting || !picked}>
    {#if connecting}
      <Spinner data-icon="inline-start" />
    {/if}
    {submitLabel}
  </Button>
{/snippet}
