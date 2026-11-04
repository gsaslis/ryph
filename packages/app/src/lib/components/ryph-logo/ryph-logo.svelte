<script module lang="ts">
/** Every lively logo on the page, so something elsewhere can set them all off. */
const lively = new Set<(strength: number) => void>();

/**
 * Sets the logo's circle wobbling like a blob of jelly, harder the higher `strength` (1 is a good
 * jolt), before it springs back into its drift. For moments worth a reaction, like a page changing.
 */
export function excite(strength = 1) {
  for (const jolt of lively) jolt(strength);
}
</script>

<script lang="ts">
import { blobPath } from "$lib/brand/blob";
import BlobFill from "$lib/brand/blob-fill.svelte";
import { BlobMotion } from "$lib/brand/blob-motion";
import { CIRCLE, LETTER_R, LETTERS, R_MIDDLE, WORDMARK_BOX } from "$lib/brand/logo";
import { cn } from "$lib/utils";

let {
  mark = false,
  folded = false,
  live = true,
  class: className,
}: {
  /** The R alone, centred in the circle, for where the whole word doesn't fit. */
  mark?: boolean;
  /**
   * The wordmark folded down to the mark, in its own box: the "yph" fades and the R glides to the
   * circle's middle, both animated, so a sidebar folding can carry the one logo between its two
   * forms instead of swapping drawings. Without `mark`.
   */
  folded?: boolean;
  /** Whether the circle is a blob that drifts, and wobbles when pointed at, clicked, or `excite`d. */
  live?: boolean;
  class?: string;
} = $props();

const { cx: CX, cy: CY, r: R } = CIRCLE;
/** The mark's square, a little larger than the circle. */
const HALF = R * 1.22;

/** The logo's box, which it takes up on the page: the wordmark's, or the mark's square. */
const box = $derived(mark ? [CX - HALF, CY - HALF, HALF * 2, HALF * 2] : [...WORDMARK_BOX]);
/**
 * Room round the box for the blob to bulge into. It's drawn inside the drawing rather than let
 * spill over its edges: a browser doesn't reliably repaint what spills out of an element, and in
 * a sticky sidebar the bulge flickered in and out, cut off at the logo's edge.
 */
const PAD = R * 0.3;

const prefersReducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The letters after the R, which fade when `folded`. */
const YPH = LETTERS.slice(LETTER_R.length);
/** How far the R moves to stand in the circle's middle. */
const R_SHIFT = [CX - R_MIDDLE[0], CY - R_MIDDLE[1]] as const;

/** Its drift and wobble (see `BlobMotion`). */
const motion = new BlobMotion();

/** The edge as a path; before anything moves, the circle itself. */
let edge = $state<string>();
let frameElement = $state<HTMLElement>();
/** Whether the colours turn: not for anyone who'd rather not have motion. */
let turning = $state(false);
let hovered = false;
let onScreen = false;
let frame = 0;
let last = 0;

function jolt(strength: number) {
  if (prefersReducedMotion()) return;
  motion.jolt(strength);
  start();
}

function start() {
  if (frame || !onScreen) return;
  last = performance.now();
  frame = requestAnimationFrame(step);
}

function step(now: number) {
  // A long gap (a background tab) shouldn't fling it.
  const dt = Math.min((now - last) / 1000, 1 / 30);
  last = now;
  // While pointed at, it's kept quivering.
  motion.step(dt, { quiver: hovered ? 0.03 : 0 });
  edge = blobPath(motion.waves(), CX, CY, R);
  frame = onScreen ? requestAnimationFrame(step) : 0;
}

$effect(() => {
  turning = !prefersReducedMotion();
});

$effect(() => {
  if (!live || !frameElement) return;
  // Without motion, a still blob: the drift at a moment where it's nicely lopsided.
  if (prefersReducedMotion()) {
    edge = blobPath(motion.waves(3), CX, CY, R);
    return;
  }
  lively.add(jolt);
  // It only moves while it can be seen.
  const watcher = new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    start();
  });
  watcher.observe(frameElement);
  return () => {
    lively.delete(jolt);
    watcher.disconnect();
    onScreen = false;
    cancelAnimationFrame(frame);
    frame = 0;
  };
});

function enter() {
  hovered = true;
  jolt(0.6);
}
function leave() {
  hovered = false;
}
</script>

<!-- Ryph's logo, as on the landing page: Ryph set in Host Grotesk ExtraBold over a circle in the brand's
     gradient (--brand-a to -e), or with `mark`, the R alone in the middle of it. The letters are
     currentColor. Live, the circle is a blob that drifts about like wax in a lava lamp; pointing at
     it, clicking it or `excite` sets it wobbling, and it springs back. The drawing reaches past the
     logo's box on every side (see PAD), so the blob bulges within the drawing rather than out of
     it. -->
<span
  bind:this={frameElement}
  class={cn("relative inline-block", className)}
  style:aspect-ratio="{box[2]} / {box[3]}"
  aria-hidden="true"
  onpointerenter={live ? enter : undefined}
  onpointerleave={live ? leave : undefined}
  onpointerdown={live ? () => jolt(1.4) : undefined}
>
  <svg
    class="absolute max-w-none"
    style:left="{(-PAD / box[2]) * 100}%"
    style:top="{(-PAD / box[3]) * 100}%"
    style:width="{((box[2] + PAD * 2) / box[2]) * 100}%"
    style:height="{((box[3] + PAD * 2) / box[3]) * 100}%"
    xmlns="http://www.w3.org/2000/svg"
    viewBox="{box[0] - PAD} {box[1] - PAD} {box[2] + PAD * 2} {box[3] + PAD * 2}">
  <BlobFill {edge} cx={CX} cy={CY} r={R} {turning} />
  {#if mark}
    <path
      fill="currentColor"
      d={LETTER_R}
      transform="translate({CX - R_MIDDLE[0]} {CY - R_MIDDLE[1]})"
    />
  {:else}
    <!-- CSS lengths on an SVG element are in the drawing's units, so the shift is R_SHIFT as is. -->
    <path
      fill="currentColor"
      d={LETTER_R}
      class="transition-[translate] duration-250 ease-in-out motion-reduce:transition-none"
      style:translate={folded ? `${R_SHIFT[0]}px ${R_SHIFT[1]}px` : "0 0"}
    />
    <path
      fill="currentColor"
      d={YPH}
      class="transition-opacity duration-250 ease-in-out motion-reduce:transition-none"
      style:opacity={folded ? 0 : 1}
    />
  {/if}
  </svg>
</span>
