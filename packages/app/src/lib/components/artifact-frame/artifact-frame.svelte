<script lang="ts">
import { Button } from "$lib/components/ui/button";
import { Skeleton } from "$lib/components/ui/skeleton";
import { Spinner } from "$lib/components/ui/spinner";
import {
  ARTIFACT_SANDBOX,
  artifactContentHref,
  type FrameSession,
  FrameStage,
  type StageView,
} from "$lib/utils/artifacts";
import { ensureFreshSession, renewSession } from "$lib/utils/auth/auth";
import { cn } from "$lib/utils";
import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
import ShieldAlertIcon from "@lucide/svelte/icons/shield-alert";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import { untrack } from "svelte";
import type { Attachment } from "svelte/attachments";

let {
  id,
  version,
  title,
  shown = $bindable(null),
  class: className,
}: {
  id: string;
  /** The version shown. A new one loads behind the current one and takes its place once ready. */
  version: number;
  /** The frame's accessible name. */
  title: string;
  /** The version on screen in the full page, once one loaded. Read-only for the parent. */
  shown?: number | null;
  class?: string;
} = $props();

const src = $derived(artifactContentHref(id, version));
/** What the full page's frames show (see `FrameStage`). */
let view = $state.raw<StageView>({ shown: null, pending: null, slow: false, stopped: null });
/**
 * The content route never refreshes the session, so a frame is loaded only once it will last
 * (refreshing first when it runs low), and a full frame refused for want of one has it renewed and
 * loads once more. Both go through the app's one deduplicated refresh.
 */
const session: FrameSession = { ready: ensureFreshSession, renew: renewSession };

/** Places a version again after it was stopped; set while the frame is mounted. */
let loadAgain: ((version: number) => void) | null = null;

function frameElement(sandbox: string, name: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", sandbox);
  frame.setAttribute("title", name);
  frame.setAttribute("referrerpolicy", "no-referrer");
  return frame;
}

/**
 * The full page, guarded. Each placement names its frame with a fresh nonce and is accepted only
 * once the document in it answers with that nonce (see `FrameGuard`). A new version loads hidden
 * behind the one on screen and replaces it once accepted. A version that strays is taken down and
 * a notice offers to load it again; one that strays while loading behind another leaves the other
 * on screen. Nothing loads again by itself.
 */
const full: Attachment<HTMLElement> = (box) => {
  const frames = new Set<HTMLIFrameElement>();
  const stage = new FrameStage(({ url, nonce, hidden, onload }) => {
    const frame = frameElement(ARTIFACT_SANDBOX, untrack(() => title));
    frame.className = "absolute inset-0 size-full border-0";
    frame.setAttribute("name", nonce);
    if (hidden) frame.style.visibility = "hidden";
    frame.addEventListener("load", onload);
    frame.src = url;
    frames.add(frame);
    box.append(frame);
    return {
      get window() {
        return frame.contentWindow;
      },
      reveal: () => (frame.style.visibility = ""),
      remove: () => {
        frames.delete(frame);
        frame.remove();
      },
    };
  }, (next) => {
    view = next;
    shown = next.shown;
  }, session);

  const onmessage = (event: MessageEvent) => stage.message(event.data, event.source);
  window.addEventListener("message", onmessage);

  $effect(() => {
    stage.place(version, src);
  });
  $effect(() => {
    const name = title;
    for (const frame of frames) frame.setAttribute("title", name);
  });

  loadAgain = (v) => stage.place(v, artifactContentHref(untrack(() => id), v));
  return () => {
    loadAgain = null;
    window.removeEventListener("message", onmessage);
    stage.dispose();
  };
};
</script>

<div class={cn("flex flex-col overflow-hidden", className)}>
  <!-- The platform's own strip over the page, so nothing inside the frame can pass for ryph. -->
  <div
    class="bg-muted text-muted-foreground flex min-h-8 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1 text-xs"
  >
      <span class="flex min-w-0 flex-1 items-center gap-1.5">
        <TriangleAlertIcon class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
        <span class="truncate">Made by an agent. Don't enter passwords here.</span>
      </span>
      {#if view.shown !== null && view.stopped !== null}
        {@const stopped = view.stopped}
        <span role="status" class="text-foreground flex items-center gap-2">
          Version {stopped} tried to leave, so it was stopped.
          <Button variant="outline" size="xs" onclick={() => loadAgain?.(stopped)}>
            <RotateCwIcon data-icon="inline-start" />
            Load again
          </Button>
        </span>
      {:else if view.pending !== null && view.slow}
        <span role="status" class="flex items-center gap-1.5">
          <Spinner class="size-3" />
          {view.shown === null ? "Still loading" : `Version ${view.pending} is still loading`}
        </span>
      {/if}
    </div>
  <div class="relative isolate min-h-0 flex-1">
      {#if view.shown === null && view.stopped === null}
        <Skeleton class="absolute inset-0 rounded-none" />
      {/if}
      <div {@attach full} class="absolute inset-0"></div>
      {#if view.shown === null && view.stopped !== null}
        {@const stopped = view.stopped}
        <div
          role="status"
          class="bg-background absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center"
        >
          <ShieldAlertIcon class="text-muted-foreground size-5" aria-hidden="true" />
          <p class="text-sm">This page tried to leave, so it was stopped.</p>
          <Button variant="outline" size="sm" onclick={() => loadAgain?.(stopped)}>
            <RotateCwIcon data-icon="inline-start" />
            Load again
          </Button>
        </div>
      {/if}
    </div>
</div>
