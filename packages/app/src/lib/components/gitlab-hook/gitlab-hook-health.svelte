<script lang="ts">
import { formatDateTime } from "$lib/utils/format";
import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
import CircleDashedIcon from "@lucide/svelte/icons/circle-dashed";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import { hookDelivery } from "./steps";

// Whether GitLab is reaching Ryph through the webhook: when it last delivered with the current
// token, or that it never has — and whether deliveries were dropped over the project's budgets.
let {
  lastDeliveryAt,
  lastMergeRequestDeliveryAt,
  droppedComments = 0,
  droppedOtherEvents = 0,
  lastDroppedAt = null,
}: {
  /** The last admitted delivery at the current token; null when none has been seen. */
  lastDeliveryAt: string | null;
  /** The same, for merge request events alone. */
  lastMergeRequestDeliveryAt: string | null;
  /** How many comments at the current token were dropped over the project's comment budget. */
  droppedComments?: number;
  /** How many other events were dropped over the budget they share. */
  droppedOtherEvents?: number;
  /** When the last of either was. */
  lastDroppedAt?: string | null;
} = $props();

const delivery = $derived(
  hookDelivery(lastDeliveryAt, lastMergeRequestDeliveryAt, {
    comments: droppedComments,
    other: droppedOtherEvents,
    lastAt: lastDroppedAt,
  }),
);
</script>

<div class="flex min-w-0 flex-col gap-1">
  <p class="flex items-center gap-1.5 text-sm font-medium">
    {#if delivery.seen}
      <CircleCheckIcon class="text-success size-4 shrink-0" aria-hidden="true" />
      <span title={lastDeliveryAt ? formatDateTime(lastDeliveryAt) : undefined}>{delivery.text}</span>
    {:else}
      <CircleDashedIcon class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
      <span>{delivery.text}</span>
    {/if}
  </p>
  {#if delivery.hint}
    <p class="text-muted-foreground text-xs">{delivery.hint}</p>
  {/if}
  {#if delivery.dropped}
    <p class="flex items-start gap-1.5 text-xs" role="status">
      <TriangleAlertIcon
        class="text-warning-foreground dark:text-warning mt-px size-3.5 shrink-0"
        aria-hidden="true"
      />
      <span>{delivery.dropped}</span>
    </p>
  {/if}
</div>
