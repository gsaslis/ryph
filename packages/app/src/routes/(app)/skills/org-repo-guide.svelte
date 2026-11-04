<script lang="ts">
import CodeView from "$lib/components/code-view/code-view.svelte";
import CopyButton from "$lib/components/copy-button/copy-button.svelte";
import { EXAMPLE_SKILL, SKILL_FILE } from "$lib/utils/skills";
import FileTextIcon from "@lucide/svelte/icons/file-text";
import FolderIcon from "@lucide/svelte/icons/folder";

let { connected = false, branch = null, nonDefaultBranch = false, canManage = true }: {
  /** The repo is already the org skills repo, so the steps start at its folders. */
  connected?: boolean;
  /** The branch Ryph reads, once connected. */
  branch?: string | null;
  /** That branch is not the repo's default one, so a push to it does not start a sync. */
  nonDefaultBranch?: boolean;
  /** The reader can press Sync now; anyone else is told who can. */
  canManage?: boolean;
} = $props();

// The tree the guide draws: one skill with its optional folders, and a second one, so the shape
// reads as "a folder per skill" rather than as one fixed path. Each folder is a list of its own,
// so a screen reader hears which folder holds which file, as the indent shows it.
interface TreeEntry {
  name: string;
  note?: string;
  /** Present on a folder, empty or not. */
  children?: TreeEntry[];
}

const TREE: TreeEntry[] = [{
  name: ".agents",
  children: [{
    name: "skills",
    children: [
      {
        name: "release",
        children: [
          { name: SKILL_FILE },
          { name: "scripts", note: "optional", children: [] },
          { name: "references", note: "optional", children: [] },
        ],
      },
      { name: "incident-runbook", children: [{ name: SKILL_FILE }] },
    ],
  }],
}];
</script>

{#snippet tree(entries: TreeEntry[], top: boolean)}
  <ul
  class={["flex flex-col gap-1", top ? "font-mono text-xs" : "mt-1 pl-3.5"]}
  aria-label={top ? "Repository layout" : undefined}
>
    {#each entries as entry, i (i)}
      <li>
        <span class="flex items-center gap-1.5">
          {#if entry.children}
            <FolderIcon class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
            <span>{entry.name}/</span>
          {:else}
            <FileTextIcon class="text-foreground size-3.5 shrink-0" aria-hidden="true" />
            <span class="font-medium">{entry.name}</span>
          {/if}
          {#if entry.note}
            <span class="text-muted-foreground font-sans">{entry.note}</span>
          {/if}
        </span>
        {#if entry.children && entry.children.length > 0}
          {@render tree(entry.children, false)}
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<!-- How to make an org skills repo: the steps, then the layout above a SKILL.md to copy. The two
     stay stacked: the guide sits in a settings column, too narrow to give the example a readable
     width beside the tree. -->
<div class="flex flex-col gap-4">
  {#if !connected}
    <p class="text-sm">Any repository can hold your org skills, one folder per skill.</p>
  {/if}

  <ol class="text-muted-foreground flex list-decimal flex-col gap-1.5 pl-5 text-sm marker:text-xs">
    {#if !connected}
      <li>Create a repository on your forge, or use one you have.</li>
      <li>
        <a href="/repos/connect" class="text-foreground underline underline-offset-4">Connect it</a>
        to Ryph.
      </li>
    {/if}
    <li>
      Add a folder under <code class="text-foreground">.agents/skills</code> for each skill, with a
      <code class="text-foreground">{SKILL_FILE}</code> in it. The folder and the
      <code class="text-foreground">name</code> must match.
    </li>
    <li>
      Write the description as when to use the skill. Agents see only the name and description, and
      read the rest when a task matches.
    </li>
    {#if !connected}
      <li>Push it, then pick the repository below.</li>
    {:else if nonDefaultBranch}
      <li>
        Push it to <code class="text-foreground">{branch}</code>, then {canManage
          ? "press Sync now"
          : "ask an admin to sync"}.
      </li>
    {:else}
      <li>
        Push it to <code class="text-foreground">{branch}</code>. Ryph syncs on every push.
      </li>
    {/if}
  </ol>

  <div class="flex flex-col overflow-hidden rounded-lg border">
    <div class="bg-muted/40 flex flex-col gap-3 border-b p-4">
      <p class="text-muted-foreground text-xs font-medium">Repository layout</p>
      {@render tree(TREE, true)}
    </div>
    <div class="flex min-w-0 flex-col">
      <div class="flex items-center justify-between gap-2 border-b py-1 pr-1 pl-4">
        <span class="font-mono text-xs">release/{SKILL_FILE}</span>
        <CopyButton value={EXAMPLE_SKILL} label="Copy the example" what="Example copied" />
      </div>
      <div class="min-w-0 p-2">
        <CodeView code={EXAMPLE_SKILL} name={SKILL_FILE} />
      </div>
    </div>
  </div>
</div>
