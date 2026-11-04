<script lang="ts">
import type { RunEvent, RunSkills } from "$lib/api/types";
import ForgeRepoLabel from "$lib/components/forge-repo-label/forge-repo-label.svelte";
import { Badge } from "$lib/components/ui/badge";
import { shortCommit } from "$lib/utils/environments";
import { runSkillsView } from "$lib/utils/skills";

let { skills, events, settled }: {
  skills: RunSkills;
  /** The run's trail, where the working repos' skills and the drops are recorded. */
  events: readonly RunEvent[];
  /** The runner has said what it loaded, or the run is over: a working repo with nothing on the
   * trail then loaded nothing, rather than nothing yet. */
  settled: boolean;
} = $props();

const view = $derived(runSkillsView(skills, events));
</script>

<!-- A run's skills by source, in the order a name is claimed: Ryph's, then the org repo's, then the
     working repos'. Then what was left out and why, so a skill the agent never saw is accounted
     for here. -->
<div class="flex flex-col gap-1.5">
  <p>
    <span class="text-muted-foreground">Ryph:</span>
    {#if view.catalogue.length > 0}
      <span class="font-mono text-xs">{view.catalogue.join(", ")}</span>
    {:else}
      none
    {/if}
  </p>
  <p class="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
    <span class="text-muted-foreground">Org:</span>
    {#if view.org}
      <span class="font-mono text-xs">{view.org.names.join(", ")}</span>
      <span class="text-muted-foreground">
        from <ForgeRepoLabel repoRef={view.org.repoRef} /> at
        <span class="font-mono text-xs" title={view.org.commit}>{shortCommit(view.org.commit)}</span>
      </span>
      {#if view.org.stale}
        <Badge variant="outline">Behind the repository</Badge>
        <span class="text-muted-foreground">The latest sync had failed.</span>
      {/if}
    {:else}
      none
    {/if}
  </p>
  <p>
    <span class="text-muted-foreground">Repos:</span>
    {#if !view.workingRepos}
      off
    {:else if view.repo.length > 0}
      {#each view.repo as skill, i (i)}
        <span><span class="font-mono text-xs">{skill.name}</span>{#if skill.path}
            <span class="text-muted-foreground">in {skill.path}/</span>{/if}{#if
            i < view.repo.length - 1},{/if}</span>
      {/each}
    {:else}
      {settled ? "none" : "none yet"}
    {/if}
  </p>
  {#if view.dropped.length > 0}
    <div class="flex flex-col gap-0.5">
      <span class="text-muted-foreground">Left out:</span>
      <ul class="flex flex-col gap-0.5 text-xs">
        {#each view.dropped as drop, i (i)}
          <li class="wrap-anywhere">
            {#if drop.where === null}
              {drop.reason}
            {:else}
              <span class="font-mono">{drop.name}</span>
              <span class="text-muted-foreground">({drop.where})</span>: {drop.reason}
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
