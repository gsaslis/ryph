<script lang="ts">
import { getAutomationFires } from "$lib/api/automations";
import type { AutomationFire } from "$lib/api/types";
import { fireOutcomeSentence } from "$lib/automations/presets";
import { Button } from "$lib/components/ui/button";
import { Spinner } from "$lib/components/ui/spinner";
import { formatDateTime, formatTime } from "$lib/utils/format";
import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";

// Watches for the sender's first request, so whoever just set it up sees it arrive. It asks for
// the automation's fires every few seconds while on screen, and stops at the first one, or when
// it leaves the page. `onlyNew` counts only fires after it opened: the automation's page reopens
// this to test a sender that has fired before.
let {
  automationId,
  vendor,
  onlyNew = false,
  waitingOnSecret = false,
}: {
  automationId: string;
  vendor: string;
  onlyNew?: boolean;
  /** The sender's secret is still to be pasted, so its requests are turned away for now. */
  waitingOnSecret?: boolean;
} = $props();

const POLL_MS = 3_000;
const SLOW_MS = 60_000;

let found = $state<AutomationFire | null>(null);
let slow = $state(false);

$effect(() => {
  if (found !== null) return;
  const id = automationId;
  const fresh = onlyNew;
  let baseline: Set<string> | null = fresh ? null : new Set();
  let stopped = false;
  async function tick() {
    try {
      const fires = await getAutomationFires(fetch, id);
      if (stopped) return;
      if (baseline === null) {
        baseline = new Set(fires.map((f) => f.id));
        return;
      }
      const seen = baseline;
      const first = fires
        .filter((f) => !seen.has(f.id))
        .sort((a, b) => a.firedAt.localeCompare(b.firedAt))[0];
      if (first !== undefined) found = first;
    } catch {
      // A missed poll is caught up by the next.
    }
  }
  void tick();
  const timer = setInterval(tick, POLL_MS);
  const slowTimer = setTimeout(() => (slow = true), SLOW_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(slowTimer);
  };
});

const outcome = $derived(found === null ? null : fireOutcomeSentence(found.outcome));
</script>

<div class="bg-muted/40 flex flex-col gap-2 rounded-lg border p-4" role="status" aria-live="polite">
  {#if found === null || outcome === null}
    <div class="flex items-center gap-2 text-sm font-medium">
      <Spinner class="text-muted-foreground" />
      {onlyNew ? "Waiting for a request…" : "Waiting for the first request…"}
    </div>
    <p class="text-muted-foreground text-sm">
      {#if waitingOnSecret}
        Save the signing secret first, then send a test from {vendor}.
      {:else if slow}
        Nothing yet. Requests with the wrong secret are turned away before they show up here, so
        check the header and the secret.
      {:else}
        Use {vendor}'s test button if it has one, or wait for the next real request.
      {/if}
    </p>
  {:else}
    <div class="flex items-center gap-2 text-sm font-medium">
      {#if outcome.ok}
        <CircleCheckIcon class="text-success size-4" />
      {:else}
        <TriangleAlertIcon class="text-destructive size-4" />
      {/if}
      {outcome.text}
    </div>
    <p class="text-muted-foreground text-sm" title={formatDateTime(found.firedAt)}>
      At {formatTime(found.firedAt)}.{#if found.detail} {found.detail}{/if}
    </p>
    {#if found.taskId !== null}
      <Button variant="outline" size="sm" class="w-fit" href="/tasks/{found.taskId}">
        Open the run
        <ArrowRightIcon data-icon="inline-end" />
      </Button>
    {/if}
  {/if}
</div>
