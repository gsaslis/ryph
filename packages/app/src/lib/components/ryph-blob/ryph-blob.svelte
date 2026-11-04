<script lang="ts">
import { blobPath } from "$lib/brand/blob";
import BlobFill from "$lib/brand/blob-fill.svelte";
import { BlobMotion } from "$lib/brand/blob-motion";
import { cn } from "$lib/utils";

let {
  mood = "idle",
  class: className,
}: {
  /**
   * `idle` is the logo's own blob, drifting like wax in a lava lamp, for an agent waiting to be
   * spoken to. `excited` is the same blob wobbling steadily and rolling faster, for one at work.
   * A change of mood eases over rather than snapping: excitement ramps up, then holds.
   */
  mood?: "excited" | "idle";
  class?: string;
} = $props();

// The logo's blob without the letters: the same motion (`BlobMotion`) and the same paint
// (`BlobFill`), so left idle the two are the same blob.

const R = 100;
/** Room round the circle for the blob to bulge into, inside the drawing (see `RyphLogo`). */
const PAD = R * 0.3;

/** Per mood: how hard it is kept wobbling (`hum`), and the fastest it settles back to rolling. */
const AGITATION = {
  idle: { hum: 0, roll: 0.22 },
  excited: { hum: 0.05, roll: 1.2 },
} as const;

const prefersReducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const motion = new BlobMotion();
let edge = $state<string>();
let element = $state<HTMLElement>();
let turning = $state(false);
let onScreen = false;
let frame = 0;
let last = 0;
/** The agitation now, eased toward the mood's. */
let hum = 0;
let roll = 0.22;

function start() {
  if (frame || !onScreen) return;
  last = performance.now();
  frame = requestAnimationFrame(step);
}

function step(now: number) {
  // A long gap (a background tab) shouldn't fling it.
  const dt = Math.min((now - last) / 1000, 1 / 30);
  last = now;
  const target = AGITATION[mood];
  // Quick to get excited (a third of a second or so), slower to calm back down.
  const ease = Math.min(dt * (target.hum > hum ? 3 : 1.2), 1);
  hum += (target.hum - hum) * ease;
  // Calmed all the way down, it is the logo's blob again, not one humming imperceptibly.
  if (target.hum === 0 && hum < 1e-4) hum = 0;
  roll += (target.roll - roll) * ease;
  motion.step(dt, { hum, roll });
  edge = blobPath(motion.waves(), 0, 0, R);
  frame = onScreen ? requestAnimationFrame(step) : 0;
}

$effect(() => {
  turning = !prefersReducedMotion();
});

$effect(() => {
  if (!element) return;
  // Without motion, a still blob: the drift at a moment where it's nicely lopsided.
  if (prefersReducedMotion()) {
    edge = blobPath(motion.waves(3), 0, 0, R);
    return;
  }
  // It only moves while it can be seen.
  const watcher = new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    start();
  });
  watcher.observe(element);
  return () => {
    watcher.disconnect();
    onScreen = false;
    cancelAnimationFrame(frame);
    frame = 0;
  };
});
</script>

<span
  bind:this={element}
  class={cn("relative inline-block size-5", className)}
  role="img"
  aria-label={mood === "excited" ? "Working" : "Idle"}
>
  <svg
    class="absolute max-w-none"
    style:left="{(-PAD / (R * 2)) * 100}%"
    style:top="{(-PAD / (R * 2)) * 100}%"
    style:width="{((R + PAD) / R) * 100}%"
    style:height="{((R + PAD) / R) * 100}%"
    xmlns="http://www.w3.org/2000/svg"
    viewBox="{-R - PAD} {-R - PAD} {(R + PAD) * 2} {(R + PAD) * 2}"
  >
    <BlobFill {edge} cx={0} cy={0} r={R} {turning} />
  </svg>
</span>
