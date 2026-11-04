<script lang="ts">
import type { EnvironmentStatus, EnvironmentView } from "$lib/api/types";
import { Badge } from "$lib/components/ui/badge";
import { TONES } from "$lib/components/ui/badge/tones";
import { Spinner } from "$lib/components/ui/spinner";
import {
  buildStatusShortLabel,
  environmentStatusLabel,
  isReadyWithSetupWarnings,
  setupWarningLabel,
} from "$lib/utils/environments";
import CheckIcon from "@lucide/svelte/icons/check";
import ClockIcon from "@lucide/svelte/icons/clock";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import XIcon from "@lucide/svelte/icons/x";

let { status, setupWarnings = null }: {
  status: EnvironmentStatus;
  setupWarnings?: EnvironmentView["setupWarnings"] | null;
} = $props();

// A ready build whose setup did not finish is still ready, but not quietly so: amber, like a
// lost run, rather than the green of a clean build.
const warned = $derived(isReadyWithSetupWarnings({ status, setupWarnings }));
const warning = $derived(setupWarningLabel(setupWarnings));

// The run and check badges' tones: a build that is still going spins, and a replaced one is
// quiet, since nothing is wrong with it.
const classes = $derived(
  warned
    ? TONES.warning
    : status === "ready"
    ? TONES.success
    : status === "failed"
    ? TONES.failure
    : status === "building"
    ? TONES.active
    : status === "superseded"
    ? TONES.neutral
    : "",
);
</script>

<Badge
  variant={classes === "" ? "outline" : "default"}
  class={classes}
  title={warned ? `${environmentStatusLabel(status)}: ${warning.toLowerCase()}` : environmentStatusLabel(status)}
>
  {#if status === "building"}
    <Spinner />
  {:else if status === "queued"}
    <ClockIcon />
  {:else if warned}
    <TriangleAlertIcon />
  {:else if status === "ready"}
    <CheckIcon />
  {:else if status === "failed"}
    <XIcon />
  {/if}
  {warned ? warning : buildStatusShortLabel(status)}
</Badge>
