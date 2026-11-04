<script lang="ts">
import { getImages, type ImageStatus, pullImages } from "$lib/api/images";
import { Button } from "$lib/components/ui/button";
import { Spinner } from "$lib/components/ui/spinner";
import CheckIcon from "@lucide/svelte/icons/check";
import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
import CircleDashedIcon from "@lucide/svelte/icons/circle-dashed";
import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
import { toast } from "svelte-sonner";
import { IMAGE_LABELS, IMAGE_POLL_MS, summarizeImages } from "./welcome";

let {
  active,
  busy = $bindable(false),
}: {
  /** Whether the section is on screen: it is only asked about while it is. */
  active: boolean;
  /** Out: whether something is still downloading, for the page's blob to show it working. */
  busy?: boolean;
} = $props();

// What ryph's runs start from, downloaded at boot. This only reports on it: a deployment that does
// not download ahead of time answers with nothing, and the section is not shown at all. Neither is
// it when the answer did not come: a task starts either way, and this is no reason to stop anyone.
let images = $state<ImageStatus[] | null>(null);
let retrying = $state(false);
/** Bumped to ask again now rather than at the next tick. */
let asked = $state(0);

const summary = $derived(summarizeImages(images ?? []));

$effect(() => {
  busy = summary.busy;
});

$effect(() => {
  void asked;
  if (!active) return;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    try {
      const next = await getImages(fetch);
      if (stopped) return;
      images = next;
      if (summarizeImages(next).busy) timer = setTimeout(read, IMAGE_POLL_MS);
    } catch {
      // A missed read leaves what was last shown; while downloads are running, ask again.
      if (!stopped && summary.busy) timer = setTimeout(read, IMAGE_POLL_MS);
    }
  };
  void read();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
});

async function retry() {
  retrying = true;
  try {
    // The answer has the downloads queued again, so the polling picks them up from there.
    images = await pullImages(fetch);
    asked += 1;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Could not start the downloads again");
  } finally {
    retrying = false;
  }
}

const STATE_WORDS: Record<ImageStatus["state"], string> = {
  present: "Ready",
  pulling: "Downloading",
  queued: "Waiting",
  failed: "Failed",
};
</script>

{#if images !== null && images.length > 0}
  <section aria-labelledby="downloads-heading" class="flex flex-col gap-3 rounded-lg border p-4">
    <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 id="downloads-heading" class="text-sm font-semibold">Downloads</h2>
      <span class="text-muted-foreground text-xs tabular-nums">
        {summary.present} of {summary.total} ready
      </span>
    </div>
    <div
      role="progressbar"
      aria-label="Downloads ready"
      aria-valuemin={0}
      aria-valuemax={summary.total}
      aria-valuenow={summary.present}
      class="bg-muted h-1.5 overflow-hidden rounded-full"
    >
      <div
        class="bg-primary h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
        style="width: {(summary.present / summary.total) * 100}%"
      ></div>
    </div>
    <ul class="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
      {#each images as item (item.name)}
        <li class="flex min-w-0 items-center gap-2" title={item.error ?? item.image}>
          <span class="flex size-4 shrink-0 items-center justify-center">
            {#if item.state === "present"}
              <CheckIcon class="text-primary size-4" />
            {:else if item.state === "pulling"}
              <Spinner class="size-3.5" />
            {:else if item.state === "failed"}
              <CircleAlertIcon class="text-destructive size-4" />
            {:else}
              <CircleDashedIcon class="text-muted-foreground size-4" />
            {/if}
          </span>
          <span class="truncate">{IMAGE_LABELS[item.name]}</span>
          <span
            class={[
              "ml-auto shrink-0 text-xs",
              item.state === "failed" ? "text-destructive" : "text-muted-foreground",
            ]}
          >
            {STATE_WORDS[item.state]}
          </span>
        </li>
      {/each}
    </ul>
    {#if summary.failed > 0}
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-destructive text-sm">
          {summary.failed === 1 ? "A download failed." : `${summary.failed} downloads failed.`}
          Check this machine's connection and try again.
        </p>
        <Button type="button" variant="outline" size="sm" disabled={retrying} onclick={retry}>
          {#if retrying}
            <Spinner data-icon="inline-start" />
          {:else}
            <RotateCwIcon data-icon="inline-start" />
          {/if}
          Retry
        </Button>
      </div>
    {:else if summary.present < summary.total}
      <p class="text-muted-foreground text-sm">
        You can start a task now. The first one waits until these finish.
      </p>
    {:else}
      <p class="text-muted-foreground text-sm">Everything is downloaded.</p>
    {/if}
  </section>
{/if}
