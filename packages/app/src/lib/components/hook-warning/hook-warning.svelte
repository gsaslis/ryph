<script lang="ts">
import PatchActions, {
  type ActionablePatch,
} from "$lib/components/patch-actions/patch-actions.svelte";
import type { PatchesRefresh } from "$lib/components/tool-call/patches-context";
import * as Alert from "$lib/components/ui/alert";
import { Button } from "$lib/components/ui/button";
import {
  heldFiles,
  HOOK_TOO_MANY,
  HOOK_WARNING_BODY,
  HOOK_WARNING_SCOPE,
  HOOK_WARNING_TITLE,
} from "$lib/utils/hook-check";
import FileDiffIcon from "@lucide/svelte/icons/file-diff";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";

let { patch, refresh, diffLink = false, role = "alert", class: className }: {
  /** A patch held for its git hook files; the caller decides that it is (`isHeld`). */
  patch: ActionablePatch;
  /** The load to re-run once the patch has moved. Given, the warning carries Approve and Reject
   * itself; left out where the page already offers them, or holds no load to re-run. */
  refresh?: PatchesRefresh;
  /** Link to the patch's own page, where its diff is. */
  diffLink?: boolean;
  /** `status` where the warning can be drawn again without news, as a virtualised transcript
   * does when a row scrolls back into view: an alert would be read out every time. */
  role?: "alert" | "status";
  class?: string;
} = $props();

const hookFiles = $derived(heldFiles(patch));
</script>

<Alert.Root variant="destructive" {role} class={className}>
  <TriangleAlertIcon />
  <Alert.Title>{HOOK_WARNING_TITLE}</Alert.Title>
  <Alert.Description class="flex flex-col gap-2 [&_p:not(:last-child)]:mb-0">
    <p>{HOOK_WARNING_BODY}</p>
    <ul
      class="bg-muted text-foreground flex flex-col gap-0.5 rounded-md px-2.5 py-1.5 font-mono text-xs"
    >
      {#each hookFiles.files as file (file)}
        <li class="wrap-anywhere">{file}</li>
      {/each}
    </ul>
    {#if hookFiles.more}
      <p class="font-medium">{HOOK_TOO_MANY}</p>
    {/if}
    <p class="text-xs">{HOOK_WARNING_SCOPE}</p>
  </Alert.Description>
  {#if refresh !== undefined || diffLink}
    <!-- Beside the description rather than in it, so its link styles stay off the buttons, and in
         the page's own colour so Reject does not read as part of the warning. -->
    <div class="text-foreground col-start-2 flex flex-wrap items-center gap-1.5 pt-3">
      {#if diffLink}
        <Button variant="outline" size="sm" href="/patches/{patch.id}">
          <FileDiffIcon data-icon="inline-start" />
          View the diff
        </Button>
      {/if}
      {#if refresh !== undefined}
        <PatchActions {patch} {refresh} />
      {/if}
    </div>
  {/if}
</Alert.Root>
