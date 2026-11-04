<script lang="ts">
import type { CheckResultState, CheckSuiteState } from "$lib/api/types";
import { Spinner } from "$lib/components/ui/spinner";
import { cn } from "$lib/utils.js";
import { checkStateLabel } from "$lib/utils/checks";
import BanIcon from "@lucide/svelte/icons/ban";
import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
import CircleDashedIcon from "@lucide/svelte/icons/circle-dashed";
import CircleXIcon from "@lucide/svelte/icons/circle-x";
import ClockIcon from "@lucide/svelte/icons/clock";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";

let { state, class: className }: { state: CheckSuiteState | CheckResultState; class?: string } =
  $props();

// The badge's state as a lone icon, for a list where a badge on every row would be the loudest
// thing on it. The label rides along for a screen reader and a hover.
const icon = $derived.by(() => {
  switch (state) {
    case "passed":
      return { Icon: CircleCheckIcon, tone: "text-success" };
    case "failed":
    case "setup_failed":
      return { Icon: CircleXIcon, tone: "text-destructive" };
    case "timed_out":
      return { Icon: ClockIcon, tone: "text-destructive" };
    case "error":
      return { Icon: TriangleAlertIcon, tone: "text-destructive" };
    case "cancelled":
      return { Icon: BanIcon, tone: "text-muted-foreground" };
    case "running":
    case "waiting":
      return null;
    default:
      return { Icon: CircleDashedIcon, tone: "text-muted-foreground" };
  }
});
</script>

<span class={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}>
  {#if icon === null}
    <Spinner class="text-primary size-full" aria-label={checkStateLabel(state)} />
  {:else}
    <icon.Icon class={["size-full", icon.tone]} aria-label={checkStateLabel(state)} />
  {/if}
</span>
