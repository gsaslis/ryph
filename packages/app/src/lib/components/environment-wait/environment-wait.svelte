<script lang="ts">
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import type { EnvironmentView } from "$lib/api/types";
import * as Alert from "$lib/components/ui/alert";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Spinner } from "$lib/components/ui/spinner";
import { buildKindLabel, buildProgress, environmentStatusLabel } from "$lib/utils/environments";

let { environmentId, build, now, starting = false, onstart }: {
  environmentId: string;
  build: EnvironmentView | null;
  now: number;
  starting?: boolean;
  onstart: () => void;
} = $props();
</script>

<Alert.Root class="gap-y-3">
  <Spinner />
  <Alert.Title>Waiting for its environment</Alert.Title>
  <Alert.Description>
    <div class="flex min-w-0 flex-col gap-4">
      {#if build}
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Badge variant="secondary">{buildKindLabel(build.kind)}</Badge>
          <span class="text-xs tabular-nums">
            {buildProgress(build, now) ?? environmentStatusLabel(build.status)}
          </span>
        </div>
      {/if}
      <p>This run will start automatically when its environment is ready.</p>
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" href="/builds/{environmentId}">
          View build
          <ChevronRightIcon data-icon="inline-end" />
        </Button>
        <Button variant="ghost" size="sm" disabled={starting} onclick={onstart}>
          {#if starting}<Spinner data-icon="inline-start" />{/if}
          Start without waiting
        </Button>
      </div>
      <p class="text-xs">
        Starting now uses the last ready environment or the default image. Setup from
        <code>.ryph/</code> may be missing.
      </p>
    </div>
  </Alert.Description>
</Alert.Root>
