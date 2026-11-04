<script lang="ts">
import { Badge } from "$lib/components/ui/badge";
import { Spinner } from "$lib/components/ui/spinner";
import type { Chip } from "./live-view";

let { chip, retrying = false }: { chip: Chip; retrying?: boolean } = $props();
</script>

<!-- Announced as it changes: a reader who cannot see the dot still hears the stream drop and come
     back. The spinners inside are drawn, not announced, so the words are said once. -->
<span aria-live="polite" aria-atomic="true" class="flex">
  {#if retrying && chip !== "ended"}
    <Badge variant="outline">
      <Spinner data-icon="inline-start" role="presentation" aria-hidden="true" />
      Reconnecting
    </Badge>
  {:else if chip === "connecting"}
    <Badge variant="outline">
      <Spinner data-icon="inline-start" role="presentation" aria-hidden="true" />
      Connecting
    </Badge>
  {:else if chip === "live"}
    <Badge variant="outline" class="gap-1.5">
      <span class="relative flex size-2" aria-hidden="true">
        <span class="bg-success absolute inline-flex size-full rounded-full opacity-60 motion-safe:animate-ping"></span>
        <span class="bg-success relative inline-flex size-2 rounded-full"></span>
      </span>
      Live
    </Badge>
  {:else if chip === "idle"}
    <Badge variant="outline" class="gap-1.5">
      <span class="bg-muted-foreground/60 size-2 rounded-full" aria-hidden="true"></span>
      Idle
    </Badge>
  {:else}
    <Badge variant="secondary">Ended</Badge>
  {/if}
</span>
