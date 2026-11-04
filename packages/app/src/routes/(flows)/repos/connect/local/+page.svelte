<script lang="ts">
import { goto } from "$app/navigation";
import { connectLocalRepo } from "$lib/api/repos";
import FlowStep from "$lib/components/flow-step/flow-step.svelte";
import { Button } from "$lib/components/ui/button";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Spinner } from "$lib/components/ui/spinner";
import { localRepoName } from "$lib/utils/forge";
import { withBackTo } from "$lib/utils/safe-path";
import LinkIcon from "@lucide/svelte/icons/link-2";
import { toast } from "svelte-sonner";
import UnavailableStep from "../unavailable-step.svelte";
import type { PageProps } from "./$types";
import { localRepoFailure, pathProblem, withoutTrailingSlash } from "./refusal";

let { data }: PageProps = $props();

let path = $state("");
let connecting = $state(false);
/**
 * Why the server refused the last path, for a refusal about the path itself; it clears as soon as
 * the path changes. A failure that says nothing about the path is a toast, and the form stays free
 * to send it again.
 */
let refusal = $state<{ path: string; message: string } | null>(null);

const problem = $derived(
  pathProblem(path) ?? (refusal && refusal.path === path ? refusal.message : null),
);

async function submit(event: SubmitEvent) {
  event.preventDefault();
  // The path as sent, so a refusal pins to it even if the field changes before the answer.
  const submitted = path;
  const trimmed = withoutTrailingSlash(submitted.trim());
  if (trimmed === "" || pathProblem(trimmed)) return;
  connecting = true;
  refusal = null;
  try {
    const repo = await connectLocalRepo(fetch, trimmed);
    toast.success(`Added ${localRepoName(repo.repoRef)} · agents start from ${repo.defaultBranch}`);
    await goto(data.backTo ?? "/repos");
  } catch (e) {
    const failure = localRepoFailure(e);
    if (failure.pinned) refusal = { path: submitted, message: failure.message };
    else toast.error(failure.message);
  } finally {
    connecting = false;
  }
}
</script>

<svelte:head>
  <title>Add a repository on this machine · Ryph</title>
</svelte:head>

{#if data.unavailable}
  <UnavailableStep headline="Add a repository on this machine" exitHref={data.backTo ?? "/repos"} />
{:else}
<form onsubmit={submit}>
  <FlowStep
    headline="Add a repository on this machine"
    description="Point Ryph at a git repository on the computer it runs on. Check out its main branch first, since agents start from that branch."
  >
    <Field.FieldGroup>
      <Field.Field>
        <Field.FieldLabel for="local-path">Path</Field.FieldLabel>
        <Input
          id="local-path"
          bind:value={path}
          placeholder="/home/you/code/my-app"
          spellcheck={false}
          autocapitalize="off"
          autocomplete="off"
          class="font-mono"
          disabled={connecting}
          aria-invalid={problem !== null}
        />
        {#if problem}
          <Field.FieldError>{problem}</Field.FieldError>
        {:else}
          <Field.FieldDescription>
            The repository's folder, with its full path. Ryph only reads what is committed, so
            commit any changes you want agents to see. When you approve a change, it shows up as a
            new branch in this repository.
          </Field.FieldDescription>
        {/if}
      </Field.Field>
    </Field.FieldGroup>

    {#snippet leftActions()}
      <Button
        variant="ghost"
        href={data.multiForge ? withBackTo("/repos/connect", data.backTo) : (data.backTo ?? "/repos")}
      >
        {data.multiForge ? "Back" : "Cancel"}
      </Button>
    {/snippet}

    {#snippet actions()}
      <Button type="submit" disabled={connecting || path.trim() === "" || problem !== null}>
        {#if connecting}
          <Spinner data-icon="inline-start" />
        {:else}
          <LinkIcon data-icon="inline-start" />
        {/if}
        Add repository
      </Button>
    {/snippet}
  </FlowStep>
</form>
{/if}
