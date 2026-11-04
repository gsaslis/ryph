<script lang="ts">
import type { CheckResultState, CheckSuiteState } from "$lib/api/types";
import { Badge } from "$lib/components/ui/badge";
import { TONES } from "$lib/components/ui/badge/tones";
import { Spinner } from "$lib/components/ui/spinner";
import { checkStateLabel, checkTone } from "$lib/utils/checks";
import BanIcon from "@lucide/svelte/icons/ban";
import CheckIcon from "@lucide/svelte/icons/check";
import ClockIcon from "@lucide/svelte/icons/clock";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import XIcon from "@lucide/svelte/icons/x";

let { state }: { state: CheckSuiteState | CheckResultState } = $props();

// The same tinted tones as the run badge, as the run badge has them: whether checks passed is the thing a
// reader scans a row for. A check that is still going gets a spinner in place of an icon.
const tone = $derived(checkTone(state));
const icon = $derived.by(() => {
  switch (state) {
    case "passed":
      return CheckIcon;
    case "failed":
    case "setup_failed":
      return XIcon;
    case "timed_out":
      return ClockIcon;
    case "error":
      return TriangleAlertIcon;
    case "cancelled":
      return BanIcon;
    default:
      return null;
  }
});
const classes = $derived(
  tone === "passed"
    ? TONES.success
    : tone === "failed"
    ? TONES.failure
    : tone === "active"
    ? TONES.active
    : state === "cancelled"
    ? TONES.neutral
    : "",
);
</script>

<Badge variant={classes === "" ? "outline" : "default"} class={classes}>
  {#if state === "running" || state === "waiting"}
    <Spinner />
  {:else if icon}
    {@const Icon = icon}
    <Icon />
  {/if}
  {checkStateLabel(state)}
</Badge>
