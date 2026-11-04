<script lang="ts">
import type { CheckSuiteView } from "$lib/api/types";
import CheckStateBadge from "$lib/components/check-state-badge/check-state-badge.svelte";
import { Badge } from "$lib/components/ui/badge";
import { countsLabel, partialLabel, suiteCounts } from "$lib/utils/checks";
import { shortCommit } from "$lib/utils/environments";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import CheckSuiteChecks from "./check-suite-checks.svelte";

// A suite as a row on another page: the checks one line each, and a link to the suite's own page.
let { suite }: { suite: CheckSuiteView } = $props();

const counts = $derived(suiteCounts(suite));
const partial = $derived(partialLabel(suite));
</script>

<!-- A check's output is the head commit's own text: it is only ever rendered as text. -->
<div class="flex flex-col gap-3 rounded-lg border p-3 text-sm">
  <div class="flex flex-wrap items-center gap-2">
    <CheckStateBadge state={suite.state} />
    <span class="font-mono text-xs" title={suite.commit}>
      {suite.repoRef ?? suite.connectedRepoId} at {shortCommit(suite.commit)}
    </span>
    {#if suite.generation > 1}
      <Badge variant="outline" title="Times this suite has run">#{suite.generation}</Badge>
    {/if}
    <span class="text-muted-foreground text-xs">{countsLabel(counts)}</span>
    {#if partial !== null}
      <Badge variant="outline" title="A run of some of the checks">{partial}</Badge>
    {/if}
    <a
      href="/checks/{suite.id}"
      class="text-muted-foreground ml-auto flex items-center gap-0.5 text-xs underline-offset-4 hover:underline"
    >
      Details
      <ChevronRightIcon class="size-3.5" />
    </a>
  </div>

  <CheckSuiteChecks {suite} />
</div>
