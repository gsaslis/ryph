<script lang="ts">
import { ApiError } from "$lib/api/call";
import { type GitlabHookStatus, rotateRepoGitlabHook } from "$lib/api/repos";
import * as Alert from "$lib/components/ui/alert";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import { Button } from "$lib/components/ui/button";
import { Spinner } from "$lib/components/ui/spinner";
import RotateCcwKeyIcon from "@lucide/svelte/icons/rotate-ccw-key";
import GitlabHookHealth from "./gitlab-hook-health.svelte";
import GitlabHookSteps from "./gitlab-hook-steps.svelte";

// A connected project's webhook on its repo page, once a Maintainer has asked for it: whether
// GitLab is delivering, the values to paste, and a way to move to a new token.
let { status, repoId, webUrl }: {
  /** The webhook as last read; a rotation replaces it here. */
  status: GitlabHookStatus;
  repoId: string;
  /** The project's page on GitLab, for a link straight to its webhooks. */
  webUrl: string | null;
} = $props();

// Rotating refuses the old URL and token at once, so it asks first, then shows the new values in
// the same steps with the delivery status back at none seen.
let current = $derived(status);
let confirmOpen = $state(false);
let rotating = $state(false);
let rotated = $state(false);
let rotateError = $state<string | null>(null);

async function rotate() {
  rotating = true;
  rotateError = null;
  try {
    current = await rotateRepoGitlabHook(fetch, repoId);
    rotated = true;
  } catch (e) {
    rotateError = e instanceof ApiError && e.status === 403
      ? "Only a Maintainer of the project on GitLab can rotate its token."
      : e instanceof Error
      ? e.message
      : "Failed to rotate the token";
  } finally {
    rotating = false;
    confirmOpen = false;
  }
}
</script>

<div class="flex flex-col gap-6">
  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <GitlabHookHealth
        lastDeliveryAt={current.lastDeliveryAt}
        lastMergeRequestDeliveryAt={current.lastMergeRequestDeliveryAt}
        droppedComments={current.droppedComments}
        droppedOtherEvents={current.droppedOtherEvents}
        lastDroppedAt={current.lastDroppedAt}
      />
      <Button
        variant="outline"
        size="sm"
        class="shrink-0"
        onclick={() => (confirmOpen = true)}
        disabled={rotating}
      >
        <RotateCcwKeyIcon data-icon="inline-start" />
        Rotate token
      </Button>
    </div>
    {#if rotateError}
      <p class="text-destructive text-sm" role="alert">{rotateError}</p>
    {/if}
  </div>

  {#if rotated}
    <Alert.Root>
      <RotateCcwKeyIcon />
      <Alert.Title>Token rotated</Alert.Title>
      <Alert.Description>
        The old token no longer works. Edit the webhook on GitLab and paste in the new URL and
        token below.
      </Alert.Description>
    </Alert.Root>
  {/if}

  <GitlabHookSteps hook={current.webhook} {webUrl} />
</div>

<AlertDialog.Root bind:open={confirmOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Rotate the webhook token?</AlertDialog.Title>
      <AlertDialog.Description>
        The current token stops working at once. GitLab's deliveries are refused until you paste
        the new URL and token into the webhook there.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={rotating}>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action disabled={rotating} onclick={rotate}>
        {#if rotating}
          <Spinner data-icon="inline-start" />
        {/if}
        Rotate token
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
