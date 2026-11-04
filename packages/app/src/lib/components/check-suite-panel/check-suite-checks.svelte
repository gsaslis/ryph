<script lang="ts">
import type { CheckSuiteView } from "$lib/api/types";
import CheckStateIcon from "$lib/components/check-state-icon/check-state-icon.svelte";
import InheritedBadge from "$lib/components/inherited-badge/inherited-badge.svelte";
import { Badge } from "$lib/components/ui/badge";
import { checkDurationMs, watchedChange } from "$lib/utils/checks";
import { formatElapsed } from "$lib/utils/format";
import { liveClock } from "$lib/utils/live-clock.svelte";

// A suite's checks, one row each, each opening its log; and the platform's note on the suite.
let { suite }: { suite: CheckSuiteView } = $props();
const clock = liveClock(() => suite.checks.some((check) => check.state === "running"));
</script>

{#if suite.checks.length > 0}
  <!-- One aligned row per check, as the checks page lists them: the state as an icon, so the
       suite's badge above stays the one verdict on the card, and the times down the right edge. Each
       row opens that check's log. -->
  <ul class="-mx-1.5 grid grid-cols-[auto_minmax(0,max-content)_minmax(0,1fr)_auto]">
    {#each suite.checks as item (item.name)}
      {@const duration = checkDurationMs(item, clock.now)}
      {@const watched = watchedChange(item)}
      <li class="col-span-full grid grid-cols-subgrid">
        <a
          href="/checks/{suite.id}?check={encodeURIComponent(item.name)}"
          class="hover:bg-muted/60 focus-visible:ring-ring/50 col-span-full grid min-h-7 grid-cols-subgrid items-center gap-x-2.5 rounded-md px-1.5 outline-none focus-visible:ring-[3px]"
        >
          <CheckStateIcon state={item.state} class="size-3.5" />
          <span class="truncate font-mono text-xs font-medium">{item.name}</span>
          <span class="flex min-w-0 items-center gap-2">
            {#if item.exitCode !== null && item.exitCode !== 0}
              <span class="text-muted-foreground text-xs">Exit {item.exitCode}</span>
            {/if}
            {#if item.inherited}
              <InheritedBadge inLink />
            {/if}
            {#if watched === "changed"}
              <Badge variant="outline" title="The change touched files this check depends on">
                Watched files changed
              </Badge>
            {:else if watched === "unknown"}
              <Badge variant="outline" title="Could not tell which files the change touched">
                Changed files unknown
              </Badge>
            {/if}
          </span>
          <span class="text-muted-foreground text-right text-xs tabular-nums">
            {duration === null ? "" : formatElapsed(duration)}
          </span>
        </a>
      </li>
    {/each}
  </ul>
{/if}

{#if suite.reason}
  <!-- The platform's own account of what went wrong, which can be technical: a detail under
       the checks, never the headline. -->
  <p class="text-muted-foreground line-clamp-1 text-xs whitespace-pre-line" title={suite.reason}>
    {suite.reason}
  </p>
{/if}
