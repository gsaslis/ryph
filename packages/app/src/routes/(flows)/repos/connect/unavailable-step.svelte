<script lang="ts">
import { invalidateAll } from "$app/navigation";
import FlowStep from "$lib/components/flow-step/flow-step.svelte";
import { Button } from "$lib/components/ui/button";
import { Spinner } from "$lib/components/ui/spinner";
import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";

let {
  headline = "Connect a repository",
  exitHref = "/repos",
}: {
  headline?: string;
  /** Where Cancel goes: the page that opened the flow, else the repositories. */
  exitHref?: string;
} = $props();

let retrying = $state(false);

async function retry() {
  retrying = true;
  try {
    await invalidateAll();
  } finally {
    retrying = false;
  }
}
</script>

<!-- What a connect step shows when the list of ways in could not be read: the flow's own frame
     with a way to ask again, rather than the generic error page. -->
<FlowStep {headline} description="Ryph could not load this right now. Try again.">
  {#snippet leftActions()}
    <Button variant="ghost" href={exitHref}>Cancel</Button>
  {/snippet}

  {#snippet actions()}
    <Button onclick={retry} disabled={retrying}>
      {#if retrying}
        <Spinner data-icon="inline-start" />
      {:else}
        <RotateCwIcon data-icon="inline-start" />
      {/if}
      Try again
    </Button>
  {/snippet}
</FlowStep>
