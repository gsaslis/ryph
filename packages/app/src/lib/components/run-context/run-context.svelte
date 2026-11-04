<script lang="ts">
import { buttonVariants } from "$lib/components/ui/button";
import * as Popover from "$lib/components/ui/popover";
import type { ContextUsage } from "./context-usage";

let { usage }: { usage: ContextUsage | null } = $props();
const ready = $derived(usage?.status === "ready");
const percent = $derived(ready ? usage!.percent! : null);
const fill = $derived(Math.min(100, percent ?? 0));
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const status = $derived(
  usage?.status === "compacting"
    ? "Compacting context…"
    : usage?.status === "recalculating"
    ? "Recalculating…"
    : "Context usage unavailable",
);
const label = $derived(ready ? `Context usage: ${number.format(percent!)}%` : status);
</script>

<Popover.Root>
  <Popover.Trigger
    class={buttonVariants({ variant: "ghost", size: "icon-sm" })}
    aria-label={label}
    title={label}
  >
    <svg viewBox="0 0 24 24" class="size-5" fill="none" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        stroke-width="3"
        class="text-muted-foreground/50"
      />
      {#if ready && fill > 0}
        <circle
          cx="12"
          cy="12"
          r="9"
          pathLength="100"
          stroke="currentColor"
          stroke-width="3"
          stroke-linecap="round"
          stroke-dasharray="{fill} 100"
          transform="rotate(-90 12 12)"
          class="text-context-usage"
        />
      {:else if !ready}
        <circle cx="12" cy="12" r="1.5" fill="currentColor" class="text-muted-foreground" />
      {/if}
    </svg>
  </Popover.Trigger>
  <Popover.Content side="top" align="end" class="w-72" aria-label="Context window">
    <div class="flex flex-col gap-3">
      <Popover.Header>
        <div class="flex items-center justify-between gap-4">
          <Popover.Title>Context window</Popover.Title>
          <span class="text-sm tabular-nums">{percent === null ? "—" : `${number.format(percent)}%`}</span>
        </div>
      </Popover.Header>
      {#if ready}
        <div
          class="bg-muted h-2 overflow-hidden rounded-full"
          role="meter"
          aria-label="Context window used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={fill}
          aria-valuetext={`Approximately ${number.format(usage!.tokens!)} of ${number.format(usage!.contextWindow!)} tokens`}
        >
          <div class="bg-context-usage h-full rounded-full" style:width="{fill}%"></div>
        </div>
        <p class="text-sm tabular-nums">
          ~{number.format(usage!.tokens!)} / {number.format(usage!.contextWindow!)} tokens
        </p>
      {:else}
        <p class="text-muted-foreground text-sm" role="status">{status}</p>
        {#if usage?.contextWindow}
          <p class="text-muted-foreground text-xs tabular-nums">
            {number.format(usage.contextWindow)} token capacity
          </p>
        {/if}
      {/if}
      <Popover.Description>
        Current context estimate, not total tokens consumed.
        Older context is automatically summarized as the window fills.
      </Popover.Description>
    </div>
  </Popover.Content>
</Popover.Root>
