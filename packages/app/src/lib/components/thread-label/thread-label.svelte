<script lang="ts">
import type { ForgeProvider, ThreadKind } from "$lib/api/types";
import { providerOfRepoRef, providerOfThread, threadLabel } from "$lib/utils/forge";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";

let {
  thread,
  provider,
  kind = null,
  repoRef = null,
  url = null,
  class: className = "",
}: {
  /** The thread's id on its forge: "12" on GitHub, "issue-12" or "mr-7" on GitLab, a 40-hex
   * object id on Radicle, a branch name for a patch delivered into a local repo. */
  thread: string | null;
  provider?: ForgeProvider;
  /** An issue or a change request, where the caller knows: GitLab numbers the two apart. */
  kind?: ThreadKind | null;
  /** Used to infer the forge where the caller has an address but no provider column. */
  repoRef?: string | null;
  /** A link only where the forge has one: a Radicle deployment may have no explorer at all. */
  url?: string | null;
  class?: string;
} = $props();

// Told, read off the repo's address, or — where a row carries neither — read off the thread id
// itself, which each forge spells unmistakably.
const resolved = $derived(
  provider ?? (repoRef ? providerOfRepoRef(repoRef) : providerOfThread(thread ?? "0")),
);
const label = $derived(thread === null ? "—" : threadLabel(resolved, kind, thread));
// A Radicle id is a hash, so it reads as one; "#12" is prose on GitHub and always has been. A
// local repo's only ref is the branch a patch landed on: "branch" in prose, the name itself in
// monospace, as the patch's own actions show it.
const mono = $derived(resolved === "radicle");
const branch = $derived(resolved === "local" && thread !== null ? thread : null);
</script>

{#snippet text()}
  {#if branch !== null}
    branch <span class="font-mono text-xs">{branch}</span>
  {:else}
    {label}
  {/if}
{/snippet}

{#if thread !== null && url}
  <a
  href={url}
  target="_blank"
  rel="noreferrer"
  class="inline-flex items-center gap-1 underline-offset-4 hover:underline {className}"
  title={mono || branch !== null ? thread : undefined}
>
  <ExternalLinkIcon class="size-3.5" />
  <span class={mono ? "font-mono text-xs" : ""}>{@render text()}</span>
</a>
{:else}
  <span
  class="{mono ? 'font-mono text-xs' : ''} {className}"
  title={(mono || branch !== null) && thread !== null ? thread : undefined}
>
    {@render text()}
  </span>
{/if}
