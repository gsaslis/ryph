<script lang="ts">
import { MediaQuery } from "svelte/reactivity";
import type { TaskStreamState } from "$lib/api/tasks";
import { Button } from "$lib/components/ui/button";
import { Spinner } from "$lib/components/ui/spinner";
import * as Tooltip from "$lib/components/ui/tooltip";
import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";

let { state: connectionState, retry, backTo, viewport }: {
  state: TaskStreamState;
  retry: () => void;
  backTo: string;
  viewport?: "desktop" | "mobile";
} = $props();

// The two list views coexist. Only the visible one owns a live region, even when resizing.
const desktop = new MediaQuery("(min-width: 80rem)");
const visible = $derived(
  viewport === undefined || (viewport === "desktop" ? desktop.current : !desktop.current),
);
let delayed = $state(false);
const recovering = $derived(connectionState === "connecting" || connectionState === "retrying");
const interrupted = $derived(connectionState === "failed" || connectionState === "auth-required");
const label = $derived(
  connectionState === "auth-required"
    ? "Session expired — sign in again"
    : "Live updates interrupted — retry",
);
$effect(() => {
  if (!recovering || !visible) return;
  const timer = setTimeout(() => {
    delayed = true;
  }, 2000);
  return () => {
    clearTimeout(timer);
    delayed = false;
  };
});
</script>

{#if visible}
  <span
  class="inline-flex shrink-0 items-center self-center"
  role="status"
  aria-live="polite"
  aria-atomic="true"
>
    {#if recovering && delayed}
      <span class="text-muted-foreground inline-flex size-6 items-center justify-center">
        <Spinner class="size-3" aria-hidden="true" role="presentation" />
        <span class="sr-only">Reconnecting…</span>
      </span>
    {:else if interrupted}
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant="destructive"
                size="icon-xs"
                aria-label={label}
                href={connectionState === "auth-required"
                  ? `/login?backTo=${encodeURIComponent(backTo)}`
                  : undefined}
                onclick={connectionState === "failed" ? retry : undefined}
              >
                <CircleAlertIcon aria-hidden="true" />
                <span class="sr-only">{label}</span>
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>{label}</Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
    {/if}
  </span>
{/if}
