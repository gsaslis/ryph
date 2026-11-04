<script lang="ts">
import type { Patch } from "$lib/api/types";
import { Badge } from "$lib/components/ui/badge";
import { formatDateTime } from "$lib/utils/format";

// How a patch's change request ended on the forge: merged, merged without this patch, merged
// with nobody able to confirm whether this patch was in it, or closed without merging.
let { landed }: { landed: NonNullable<Patch["landed"]> } = $props();

const LABELS = { merged: "Merged", missed: "Not in merge", closed: "Closed" } as const;
const label = $derived(
  landed.kind === "missed" && landed.unproven === true ? "Not confirmed" : LABELS[landed.kind],
);
</script>

<Badge variant={landed.kind === "merged" ? "default" : "outline"} title={formatDateTime(landed.at)}>
  {label}
</Badge>
