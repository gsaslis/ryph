<script lang="ts">
import { cubicInOut } from "svelte/easing";
import { prefersReducedMotion as still } from "svelte/motion";
import { fly } from "svelte/transition";
import {
  evilWorkingVerbs,
  nextWorkingVerbIndex,
  workingVerbIntervalMs,
  workingVerbs,
} from "./working-verbs";

let { agentName, activity, evil = $bindable(false) }: {
  agentName: string;
  activity: "pending" | "working" | "idle";
  /** Whether the verb showing now is an evil one, for the face beside it to match. */
  evil?: boolean;
} = $props();

let verbIndex = $state(0);
const word = $derived(activity === "idle" ? "idle" : `${workingVerbs[verbIndex]}…`);
$effect(() => {
  evil = activity === "working" && evilWorkingVerbs.has(workingVerbs[verbIndex]);
});
let phraseWidth = $state(0);
let prefixWidth = $state(0);

$effect(() => {
  if (activity !== "working") return;
  verbIndex = nextWorkingVerbIndex();
  const timer = setInterval(() => {
    verbIndex = nextWorkingVerbIndex(verbIndex);
  }, workingVerbIntervalMs);
  return () => clearInterval(timer);
});
</script>

<!-- Keep the name still; only the word slides and fades in the shared grid cell. Do not announce
     decorative verb changes to screen readers, which get the actual activity instead. -->
<div class="self-center text-sm">
  {#if activity !== "pending"}
    <span class="sr-only">{agentName} is {activity === "idle" ? "idle" : "working"}</span>
    <p
      aria-hidden="true"
      class="inline-flex text-muted-foreground"
      class:working={activity === "working"}
      bind:clientWidth={phraseWidth}
      style:--phrase-width={`${phraseWidth}px`}
    >
      <span class="paint pr-[0.25em]" bind:clientWidth={prefixWidth}>{agentName} is</span>
      <span class="inline-grid" style:--text-offset={`${prefixWidth}px`}>
        {#key word}
          <span
            class="paint [grid-area:1/1]"
            in:fly={{
              y: still.current ? 0 : "0.6em",
              opacity: 0,
              duration: still.current ? 0 : 400,
              easing: cubicInOut,
            }}
            out:fly={{
              y: still.current ? 0 : "-0.6em",
              opacity: 0,
              duration: still.current ? 0 : 400,
              easing: cubicInOut,
            }}
          >{word}</span>
        {/key}
      </span>
    </p>
  {/if}
</div>

<style>
/* Animate one inherited phase, not separate animations which restart for each new word.
   Each text fragment paints the same phrase-wide gradient at its own horizontal offset. */
@property --activity-shimmer-phase {
  syntax: "<number>";
  inherits: true;
  initial-value: 1;
}

.working {
  animation: activity-shimmer 2.2s linear infinite;
}

.working .paint {
  color: transparent;
  background-image: linear-gradient(
    90deg,
    var(--muted-foreground) 40%,
    var(--foreground) 50%,
    var(--muted-foreground) 60%
  );
  background-clip: text;
  background-size: calc(var(--phrase-width) * 3) 100%;
  background-position-x: calc(
    var(--phrase-width) * -2 * var(--activity-shimmer-phase) - var(--text-offset, 0px)
  );
}

@keyframes activity-shimmer {
  from {
    --activity-shimmer-phase: 1;
  }
  to {
    --activity-shimmer-phase: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .working {
    animation: none;
  }
}
</style>
