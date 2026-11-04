<script lang="ts">
import type { PatchState } from "$lib/api/types";
import { Badge } from "$lib/components/ui/badge";
import { Spinner } from "$lib/components/ui/spinner";

let { state, held = null }: {
  state: PatchState;
  /** Why a waiting patch is held for a person (`heldReason`): it reads "held", the reason on
   * hover. */
  held?: string | null;
} = $props();

const isHeld = $derived(state === "pending_approval" && held !== null);

const active = $derived(state === "queued" || state === "submitting");

const variant = $derived.by(() => {
  switch (state) {
    case "submitted":
      return "default" as const;
    case "failed":
      return "destructive" as const;
    case "rejected":
    case "superseded":
      return "outline" as const;
    default:
      return "secondary" as const;
  }
});

// Sentence case, as every other badge: "Pending approval", "Submitted".
const label = $derived.by(() => {
  if (isHeld) return "Held";
  const words = state.replace("_", " ");
  return words[0].toUpperCase() + words.slice(1);
});
</script>

<Badge variant={isHeld ? "outline" : variant} title={isHeld ? held : undefined}>
  {#if active}
    <Spinner />
  {/if}
  {label}
</Badge>
