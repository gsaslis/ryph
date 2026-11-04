<script lang="ts">
import type { RadicleRepoInfo } from "$lib/api/types";
import CommandBlock from "$lib/components/command-block/command-block.svelte";
import CopyButton from "$lib/components/copy-button/copy-button.svelte";
import { Badge } from "$lib/components/ui/badge";
import { shortenDid } from "$lib/utils/forge";

let {
  repoRef,
  info,
  mine = false,
}: {
  /** The RID, which is the repo's whole address. Defaults to the one the node read back. */
  repoRef?: string;
  info: RadicleRepoInfo;
  /** Radicle user mode: the node and identity are the machine owner's, and Ryph's patches are
   * signed as them. Any member may be looking, so the copy names the identity, never "you". */
  mine?: boolean;
} = $props();

const rid = $derived(repoRef ?? info.rid);
const who = $derived(info.alias ?? shortenDid(info.did));
</script>

<div class="flex flex-col gap-4 text-sm">
  <dl class="grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
    <dt class="text-muted-foreground">Name</dt>
    <dd class="font-medium">{info.name}</dd>

    <dt class="text-muted-foreground">Repository id</dt>
    <dd class="flex min-w-0 items-center gap-1">
      <code class="truncate font-mono text-xs">{rid}</code>
      <CopyButton value={rid} label="Copy the repository id" what="Repository id copied" />
    </dd>

    <dt class="text-muted-foreground">Default branch</dt>
    <dd class="font-mono text-xs">{info.defaultBranch}</dd>

    <dt class="text-muted-foreground">Visibility</dt>
    <dd>
      <Badge variant={info.visibility === "private" ? "outline" : "secondary"}>
        {info.visibility}
      </Badge>
    </dd>

    <dt class="text-muted-foreground">Delegates</dt>
    <dd class="flex flex-col gap-0.5">
      {#each info.delegates as delegate (delegate)}
        <span class="font-mono text-xs" title={delegate}>{shortenDid(delegate)}</span>
      {:else}
        <span class="text-muted-foreground">None listed.</span>
      {/each}
    </dd>

    <dt class="text-muted-foreground">{mine ? "Acting as" : "Ryph's identity"}</dt>
    <dd class="flex min-w-0 items-center gap-1">
      <span class="font-mono text-xs" title={info.did}>{shortenDid(info.did)}</span>
      {#if info.alias}
        <span class="text-muted-foreground">as "{info.alias}"</span>
      {/if}
      <CopyButton value={info.did} label={mine ? "Copy the DID" : "Copy Ryph's DID"} what="DID copied" />
    </dd>
  </dl>

  <!-- The one thing about Radicle that will otherwise be discovered the hard way: a node only
       fetches the namespaces of delegates and of peers it follows, so Ryph's patches simply do
       not appear on a maintainer's machine until they follow it. -->
  <div class="flex flex-col gap-3 rounded-lg border p-3">
    {#if info.isDelegate && mine}
      <p>
        {who} is a <span class="font-medium">delegate</span> of this repository, so everyone who
        seeds it sees the patches Ryph opens as {who}.
      </p>
    {:else if mine}
      <p class="font-medium">Maintainers must follow {who} to see Ryph's patches</p>
      <CommandBlock
        command={info.followCommands.inWorkingCopy}
        caption="From inside a working copy of the repository"
      />
      <CommandBlock command={info.followCommands.anywhere} caption="From anywhere" />
    {:else if info.isDelegate}
      <p>
        Ryph is a <span class="font-medium">delegate</span> of this repository, so every node that
        seeds it already fetches Ryph's namespace. Nobody has to follow anything — its patches
        show up like any maintainer's.
      </p>
    {:else}
      <div class="flex flex-col gap-1">
        <p class="font-medium">Maintainers must follow Ryph, or they will not see its patches</p>
        <p class="text-muted-foreground">
          A Radicle node only fetches the work of a repository's delegates and of the peers it
          follows. Ryph is neither here, so until each maintainer runs one of these commands on
          their own machine, the patches Ryph opens on this repository are invisible to them —
          they are pushed and gossiped, but never asked for. Send it to everyone who works on
          this repository.
        </p>
      </div>
      <CommandBlock
        command={info.followCommands.inWorkingCopy}
        caption="From inside a working copy of the repository"
      />
      <CommandBlock command={info.followCommands.anywhere} caption="From anywhere" />
    {/if}
    <!-- On a private repository "may Ryph fetch this at all" is a separate question from "will
         anyone see its patches", and it is answered by the repo's own allow set. The node told
         us which side of it Ryph is on, so say so rather than describing the rule. -->
    {#if info.visibility === "private" && mine}
      {#if !info.isAllowed}
        <div class="flex flex-col gap-2">
          <p>
            This repository is private and <span class="font-medium">{who} is not on its allow
            list</span>, so this machine's node cannot fetch it. A delegate fixes it with one
            command.
          </p>
          <CommandBlock
            command={`rad id update --allow ${info.did}`}
            caption="Run by a delegate, inside a working copy of the repository"
          />
        </div>
      {/if}
    {:else if info.visibility === "private"}
      {#if info.isAllowed}
        <p class="text-muted-foreground">
          This repository is private, and
          <span class="text-foreground font-medium">Ryph is on its allow list</span> — its node
          may fetch the repository. Removing Ryph's DID from the allow set stops that, and every
          run against it.
        </p>
      {:else}
        <div class="flex flex-col gap-2">
          <p>
            This repository is private and
            <span class="font-medium">Ryph is not on its allow list</span>, so its node cannot
            fetch the repository — no run against it can check anything out. A delegate fixes it
            with one command.
          </p>
          <CommandBlock
            command={`rad id update --allow ${info.did}`}
            caption="Run by a delegate, inside a working copy of the repository"
          />
        </div>
      {/if}
    {/if}
  </div>
</div>
