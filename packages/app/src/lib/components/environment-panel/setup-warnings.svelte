<script lang="ts">
import type { EnvironmentView } from "$lib/api/types";
import * as Alert from "$lib/components/ui/alert";
import { setupUnfinished, setupWarningLabel } from "$lib/utils/environments";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";

// The repos whose setup.yml did not finish when a build baked it, or whose tree was put back. The
// build is still ready (setup is an optimization), which is why this has to be said: the image
// lacks what the skipped steps would have done, or what setup left in the tree. The summaries and
// details are partly the repo's own words, so plain text.
let { warnings }: { warnings: EnvironmentView["setupWarnings"] } = $props();

// A step failed or a setup.yml was invalid somewhere; else, when the build's record could not be
// read, nobody knows whether setup finished; else only `dirty` warnings: every setup finished,
// and only what it left in the tree was discarded.
const unfinished = $derived(setupUnfinished(warnings));
const unknown = $derived(!unfinished && warnings.some((warning) => warning.kind === "unreadable"));
</script>

{#if warnings.length > 0}
  <Alert.Root variant="destructive">
  <TriangleAlertIcon />
  <Alert.Title>{setupWarningLabel(warnings)}</Alert.Title>
  <Alert.Description>
    <p>
      {unfinished
        ? "The image was built without the rest of these steps. Runs will retry them and warn."
        : unknown
        ? "The build's setup record couldn't be read, so it's unknown whether every step finished. Runs will rerun setup and warn if a step fails."
        : "Setup left files changed, so they were discarded. Runs will warn the same way."}
    </p>
    <ul class="flex flex-col gap-2">
        {#each warnings as warning (`${warning.path}:${warning.kind}`)}
          <li class="flex min-w-0 flex-col gap-1">
            <span class="wrap-anywhere">{warning.summary}</span>
            {#if warning.detail}
              <pre
                class="bg-muted text-muted-foreground max-h-48 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap wrap-anywhere">{warning.detail}</pre>
            {/if}
          </li>
        {/each}
      </ul>
  </Alert.Description>
</Alert.Root>
{/if}
