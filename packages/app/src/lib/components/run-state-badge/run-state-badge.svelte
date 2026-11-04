<script lang="ts">
import type { Phase, RunState } from "$lib/api/types";
import { Badge } from "$lib/components/ui/badge";
import { TONES } from "$lib/components/ui/badge/tones";
import { Spinner } from "$lib/components/ui/spinner";
import BanIcon from "@lucide/svelte/icons/ban";
import CheckIcon from "@lucide/svelte/icons/check";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import UnplugIcon from "@lucide/svelte/icons/unplug";
import XIcon from "@lucide/svelte/icons/x";

let { state, phase = null }: {
  state: RunState;
  phase?: Phase | null;
} = $props();

const active = $derived(state === "starting" || state === "running");

// Tinted fills with the outcome's colour carried by the text: on a dense list a column of solid
// pills is louder than the rows it labels, and a pale wash under full-strength text still says how
// a run ended at a glance.
//
// Cancelled is the only one without a colour of its own: it is not an outcome so much as the
// absence of one, and a neutral tint is what says that.
//
// Running states show a spinner in place of an icon; the icon is what a settled run gets instead.
//
// A settled run is labelled with the noun for how it ended rather than the verb it ended with —
// "Error", not "Errored". The two live states stay participles: they describe what is happening.
const STATES: Record<RunState, { label: string; icon: typeof CheckIcon | null; class: string }> = {
  starting: { label: "Starting", icon: null, class: TONES.active },
  running: { label: "Running", icon: null, class: TONES.active },
  succeeded: { label: "Success", icon: CheckIcon, class: TONES.success },
  failed: { label: "Failure", icon: XIcon, class: TONES.failure },
  errored: { label: "Error", icon: TriangleAlertIcon, class: TONES.failure },
  cancelled: { label: "Cancelled", icon: BanIcon, class: TONES.neutral },
  lost: { label: "Lost", icon: UnplugIcon, class: TONES.warning },
};

const badge = $derived(STATES[state]);
</script>

<Badge class={badge.class}>
  {#if active}
    <Spinner />
  {:else if badge.icon}
    {@const Icon = badge.icon}
    <Icon />
  {/if}
  {badge.label}{#if active && phase && phase !== state}&nbsp;· {phase}{/if}
</Badge>
