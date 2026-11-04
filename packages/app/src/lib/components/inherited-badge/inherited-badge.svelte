<script lang="ts">
import { Badge } from "$lib/components/ui/badge";
import * as Tooltip from "$lib/components/ui/tooltip";
import InfoIcon from "@lucide/svelte/icons/info";

/** Inside a link, the link is the tab stop: the badge then shows its tooltip on hover only. */
let { inLink = false }: { inLink?: boolean } = $props();
</script>

<!-- A pass taken from an earlier run of the same commit's checks. The trigger is a span, not a
     button, so it can sit inside the suite card's link. -->
<Tooltip.Root>
  <Tooltip.Trigger>
    {#snippet child({ props })}
      <span {...inLink ? { ...props, tabindex: -1 } : props}>
        <Badge variant="outline">
          Inherited
          <InfoIcon data-icon="inline-end" />
        </Badge>
      </span>
    {/snippet}
  </Tooltip.Trigger>
  <Tooltip.Content>
    This check passed in an earlier run on the same commit, so that result was reused instead of
    running it again.
  </Tooltip.Content>
</Tooltip.Root>
