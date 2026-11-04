<script lang="ts">
import * as Card from "$lib/components/ui/card";
import type { Snippet } from "svelte";

let {
  headline,
  description,
  children,
  leftActions,
  actions,
}: {
  headline: string;
  description?: string;
  children?: Snippet;
  leftActions?: Snippet;
  actions?: Snippet;
} = $props();
</script>

<!-- Out past the flow column by its own padding, so the step's text sits on the column and
     the card frames it: the card primitive stays in its column, this one reaches. -->
<Card.Root class="-mx-(--card-spacing)">
  <Card.Header>
    <Card.Title class="text-xl">{headline}</Card.Title>
    {#if description}
      <Card.Description>{description}</Card.Description>
    {/if}
  </Card.Header>
  <Card.Content>
    {@render children?.()}
  </Card.Content>
  {#if leftActions || actions}
    <Card.Footer class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        {@render leftActions?.()}
      </div>
      <div class="flex items-center gap-2">
        {@render actions?.()}
      </div>
    </Card.Footer>
  {/if}
</Card.Root>
