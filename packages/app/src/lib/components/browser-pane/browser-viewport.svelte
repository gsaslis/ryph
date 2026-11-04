<script lang="ts">
import type { LiveFrame } from "$lib/api/browser-live";
import { Skeleton } from "$lib/components/ui/skeleton";
import { FramePainter } from "./frame-painter";
import { type Chip, highlightBox, type LiveView, viewportOf } from "./live-view";

let {
  frame,
  highlight,
  chip,
  maxHeight,
}: {
  frame: LiveFrame | null;
  highlight: LiveView["highlight"];
  chip: Chip;
  /** The tallest the picture may be drawn, in px; it is as wide as its box otherwise. */
  maxHeight: number;
} = $props();

/** The page's shape: the frame's, or the default viewport's before there is one. */
const aspect = $derived(frame === null ? 1280 / 800 : frame.width / frame.height);
let areaWidth = $state(0);
const width = $derived(Math.max(0, Math.min(areaWidth, maxHeight * aspect)));

const ended = $derived(chip === "ended");

/**
 * The ring for the newest action that pointed at something. Measured against the viewport the
 * frame on screen shows, so it lands where the agent acted at whatever size the frame is drawn.
 */
const ring = $derived(
  highlight === null || frame === null || ended
    ? null
    : highlightBox(highlight.target, viewportOf(frame)),
);

/**
 * One painter for the canvas's life. The frame is read in an effect of its own, so a new frame
 * repaints without the attachment (and the painter) being torn down for it.
 */
function paint(canvas: HTMLCanvasElement) {
  const painter = new FramePainter(canvas);
  $effect(() => painter.paint(frame));
  return () => painter.dispose();
}
</script>

<div bind:clientWidth={areaWidth} class="flex justify-center">
  <div
    class="bg-muted relative overflow-hidden rounded-md border shadow-xs"
    style:width="{width}px"
    style:aspect-ratio={aspect}
  >
    <canvas
      {@attach paint}
      aria-label="The agent's browser"
      class={[
        "absolute inset-0 size-full transition-[opacity,filter] duration-500",
        ended && "opacity-45 grayscale",
        frame === null && "invisible",
      ]}
    ></canvas>

    {#if ring !== null && highlight !== null}
      {#key highlight.id}
        <div
          aria-hidden="true"
          class="ping pointer-events-none absolute min-h-3 min-w-3 rounded-[3px]"
          style:left="{ring.left}%"
          style:top="{ring.top}%"
          style:width="{ring.width}%"
          style:height="{ring.height}%"
        ></div>
      {/key}
    {/if}

    {#if frame === null && chip === "connecting"}
      <Skeleton class="absolute inset-0 rounded-none" />
    {:else if frame === null && !ended}
      <div class="text-muted-foreground absolute inset-0 grid place-items-center p-4 text-center text-xs">
        Opens when the agent first uses it
      </div>
    {/if}
    {#if ended}
      <div class="absolute inset-0 grid place-items-center p-4">
        <span class="bg-background/90 text-foreground rounded-full border px-3 py-1 text-xs font-medium shadow-sm">
          Browser session ended
        </span>
      </div>
    {/if}
  </div>
</div>

<style>
/* Where the agent just acted: in fast, held, then gone. The ring sits outside the target's box,
   so the thing it points at stays readable under it. */
.ping {
  box-shadow:
    0 0 0 2px var(--primary),
    0 0 0 6px color-mix(in oklab, var(--primary) 22%, transparent);
  animation: ping 1.8s ease-out forwards;
}

@keyframes ping {
  0% {
    opacity: 0;
    transform: scale(1.4);
  }
  12% {
    opacity: 1;
    transform: scale(1);
  }
  70% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ping {
    animation: hold 1.8s linear forwards;
  }

  @keyframes hold {
    0%,
    80% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }
}
</style>
