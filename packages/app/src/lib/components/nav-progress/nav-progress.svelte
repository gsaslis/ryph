<script lang="ts">
import { onDestroy, untrack } from "svelte";
import { navigating } from "$app/state";

// A thin bar across the top of the screen for a page navigation that is taking a while. It waits
// `DELAY` before it shows, so a navigation that settles at once never flashes it. Once shown it
// simulates progress: a quick start that eases off towards `CEILING` and never reaches it. When
// the navigation completes it runs to 100%, then pushes up and out of the screen.
const DELAY = 200;
const TICK = 100;
const CEILING = 0.95;
const EASE = 0.06;
const FILL_MS = 200;
// How long the full bar stays on screen after the navigation succeeds, before it pushes out.
const HOLD_MS = 300;
const LEAVE_MS = 400;

type Phase = "idle" | "loading" | "filling" | "leaving";

let phase = $state<Phase>("idle");
let progress = $state(0);
let generation = $state(0);
let finishTimers: ReturnType<typeof setTimeout>[] = [];

function clearFinishTimers() {
  finishTimers.forEach(clearTimeout);
  finishTimers = [];
}

onDestroy(clearFinishTimers);

const active = $derived(navigating.to !== null);

// Only `active` may re-run this: the body writes `phase` and `progress`, and reacting to those would
// cancel its own timers.
$effect(() => (active ? start() : untrack(finish)));

function start() {
  return untrack(() => {
    let ticker: ReturnType<typeof setInterval> | undefined;
    const timer = setTimeout(() => {
      clearFinishTimers();
      // A fresh element has no previous transform to transition from, even when the old bar
      // is still filling or sliding away. Subsequent ticks animate on this new element.
      generation += 1;
      progress = 0.08;
      phase = "loading";
      ticker = setInterval(() => {
        progress += (CEILING - progress) * EASE;
      }, TICK);
    }, DELAY);
    return () => {
      clearTimeout(timer);
      clearInterval(ticker);
    };
  });
}

// Resolved: to 100%, then out.
function finish() {
  if (phase !== "loading") return;
  phase = "filling";
  progress = 1;
  finishTimers = [
    setTimeout(() => (phase = "leaving"), FILL_MS + HOLD_MS),
    setTimeout(() => {
      phase = "idle";
      progress = 0;
    }, FILL_MS + HOLD_MS + LEAVE_MS),
  ];
}
</script>

<!-- Named so a view transition keeps it as its own layer, on top and unfaded, instead of
     cross-fading it with the rest of the page (see layout.css). -->
{#key generation}
<div
  class="nav-progress {phase}"
  role="progressbar"
  aria-label="Loading page"
  aria-hidden={phase === "idle"}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={Math.round(progress * 100)}
>
  <div class="bar" style:transform="scaleX({progress})" style:--fill-ms="{FILL_MS}ms"></div>
</div>
{/key}

<style>
.nav-progress {
  position: fixed;
  inset: 0 0 auto 0;
  height: 3px;
  z-index: 100;
  overflow: hidden;
  pointer-events: none;
  opacity: 0;
  transform: translateY(0);
  view-transition-name: nav-progress;
}
.nav-progress.loading,
.nav-progress.filling,
.nav-progress.leaving {
  opacity: 1;
}
/* Pushed up off the top edge of the screen, fully opaque: it is the move that takes it away. */
.nav-progress.leaving {
  transform: translateY(-100%);
  transition: transform 400ms cubic-bezier(0.5, 0, 0.9, 0.4);
}
.bar {
  height: 100%;
  width: 100%;
  transform-origin: left center;
  background: var(--primary);
  transition: transform 100ms linear;
}
.nav-progress.filling .bar {
  transition: transform var(--fill-ms) ease-out;
}
/* Back at rest, and starting a run: jump to the start without animating. */
.nav-progress.idle .bar {
  transition: none;
}
@media (prefers-reduced-motion: reduce) {
  .bar,
  .nav-progress.leaving {
    transition: none;
  }
}
</style>
