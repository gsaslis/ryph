<script lang="ts">
import FlowStep from "$lib/components/flow-step/flow-step.svelte";
import { Button } from "$lib/components/ui/button";
import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";

let { data } = $props();
</script>

<svelte:head>
  <title>Preview unavailable · Ryph</title>
</svelte:head>

<FlowStep
  headline="This preview isn't available"
  description="Its run may have ended, you may not be able to see it, or it could not be reached just now."
>
  {#snippet leftActions()}
    <Button variant="ghost" href="/">Back to Ryph</Button>
  {/snippet}

  {#snippet actions()}
    {#if data.retry}
      <!-- A full page load: the open answers with a redirect to the preview's own origin. -->
      <Button href={data.retry} data-sveltekit-reload>
        <RotateCwIcon data-icon="inline-start" />
        Try again
      </Button>
    {/if}
  {/snippet}
</FlowStep>
