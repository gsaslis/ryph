<script lang="ts">
import type { RunArtifact } from "$lib/api/types";
import ArtifactFrame from "$lib/components/artifact-frame/artifact-frame.svelte";
import { Button } from "$lib/components/ui/button";
import { artifactHref } from "$lib/utils/artifacts";
import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";

let {
  artifact,
  onback,
}: {
  /** As the task detail has it now: a new version the agent publishes arrives here. */
  artifact: RunArtifact;
  /** Back to the run's actions. */
  onback: () => void;
} = $props();

let root = $state<HTMLElement | null>(null);
/** The version on screen. A newer one loads behind it until it is ready. */
let shown = $state<number | null>(null);
let back = $state<HTMLElement | null>(null);

// Opening the artifact moves focus here, so the keyboard lands on the way back.
$effect(() => {
  back?.focus();
});

/** Escape goes back, unless something inside the pane (a menu, say) took it first. */
function onkeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented || root === null) return;
  const focused = document.activeElement;
  if (focused !== null && focused !== document.body && !root.contains(focused)) return;
  event.preventDefault();
  onback();
}
</script>

<svelte:window {onkeydown} />

<!-- An artifact opened from the run's actions, in the pane. It follows the latest version: each
     reload of the task brings the newest one, which replaces the frame once it has loaded. -->
<div bind:this={root} class="flex min-h-0 flex-1 flex-col">
  <div class="flex shrink-0 items-center gap-2 px-3 py-2.5">
    <Button
      bind:ref={back}
      variant="ghost"
      size="icon-sm"
      onclick={onback}
      aria-label="Back to actions"
      title="Back to actions"
    >
      <ArrowLeftIcon />
    </Button>
    <div class="flex min-w-0 flex-1 flex-col">
      <span class="truncate text-sm font-medium" title={artifact.title}>{artifact.title}</span>
      <span class="text-muted-foreground text-xs tabular-nums">
        Version {shown ?? artifact.currentVersion}
      </span>
    </div>
    <Button
      href={artifactHref(artifact.id)}
      target="_blank"
      rel="noopener"
      variant="outline"
      size="sm"
    >
      Open page
      <ExternalLinkIcon data-icon="inline-end" />
    </Button>
  </div>
  <div class="bg-background mx-2 mb-2 flex min-h-0 flex-1 overflow-hidden rounded-lg border">
    <ArtifactFrame
      id={artifact.id}
      version={artifact.currentVersion}
      title={artifact.title}
      bind:shown
      class="min-h-0 flex-1"
    />
  </div>
</div>
