<script lang="ts">
import { onMount, type Snippet } from "svelte";

let { children }: { children: Snippet } = $props();
let content: HTMLDivElement;
let height = $state<number | undefined>(undefined);

// Observe the natural inner height, never the animated outer box. This handles streamed
// content, wrapped error messages, and viewport changes without guessing a maximum height.
onMount(() => {
  const observer = new ResizeObserver(() => {
    height = content.getBoundingClientRect().height;
  });
  observer.observe(content);
  height = content.getBoundingClientRect().height;
  return () => observer.disconnect();
});
</script>

<div class="panel" style:height={height === undefined ? undefined : `${height}px`}>
  <div bind:this={content} class="flex min-w-0 flex-col gap-4">
    {@render children()}
  </div>
</div>

<style>
.panel {
  overflow: clip;
  overflow-clip-margin: 4px;
  transition: height 300ms ease;
}
@media (prefers-reduced-motion: reduce) {
  .panel {
    transition: none;
  }
}
</style>
