<script lang="ts">
import FlowStep from "$lib/components/flow-step/flow-step.svelte";
import { Button } from "$lib/components/ui/button";
import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
</script>

<svelte:head>
  <title>Sign in · Ryph</title>
</svelte:head>

<!-- A plain form post: it works before the page hydrates, and the action redirects either way. -->
<form method="POST">
  <FlowStep headline="Sign in to Ryph" description="Continue to sign in on this browser.">
    {#snippet actions()}
      <Button type="submit">
        <ArrowRightIcon data-icon="inline-start" />
        Continue
      </Button>
    {/snippet}
  </FlowStep>
</form>
