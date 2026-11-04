<script lang="ts" module>
import type { Patch } from "$lib/api/types";

/** What the actions read off a patch: a task's patch and the approval queue's both carry it. */
export type ActionablePatch =
  & Pick<
    Patch,
    | "id"
    | "state"
    | "provider"
    | "forgeUrl"
    | "forgeRef"
    | "title"
    | "branchName"
    | "hookCheck"
    | "hooksPending"
    | "hookCheckError"
    | "heldReason"
  >
  & {
    taskTitle?: string | null;
    /** Whether the patch's run still goes on: a held patch is not approvable until it ends. */
    runLive?: boolean;
    /** Whether its hold waits for the run to end, not only for a person. */
    heldUntilRunEnds?: boolean;
  };
</script>

<script lang="ts">
import { goto, invalidate } from "$app/navigation";
import { type ApprovalBasis, approvePatch, rejectPatch, retryPatch } from "$lib/api/patches";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import { Button } from "$lib/components/ui/button";
import { Spinner } from "$lib/components/ui/spinner";
import type { PatchesRefresh } from "$lib/components/tool-call/patches-context";
import { providerOfThread, threadLabel } from "$lib/utils/forge";
import {
  approvalHookPaths,
  approvalRefusal,
  approvalRefusalMessage,
  approveBlock,
  HOOK_CONFIRM_BODY,
  HOOK_CONFIRM_TITLE,
  isLocalPatch,
  refusalNeedsReview,
  snapshotHookFiles,
} from "$lib/utils/hook-check";
import CheckIcon from "@lucide/svelte/icons/check";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import GitBranchIcon from "@lucide/svelte/icons/git-branch";
import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
import XIcon from "@lucide/svelte/icons/x";
import { toast } from "svelte-sonner";

let { patch, size = "sm", refresh, diffBasis, ready = true, onBasisMoved }: {
  patch: ActionablePatch;
  size?: "sm" | "default";
  /** The load to re-run once the patch has moved: its dependency, or the page's own way to. */
  refresh: PatchesRefresh;
  /** What the diff on screen was measured against: an approval made looking at it is refused
   * if that has moved since. Left out where no diff is shown. */
  diffBasis?: ApprovalBasis;
  /** Whether what approving or retrying publishes is on screen: the diff, loaded. */
  ready?: boolean;
  /** An approval was refused because the diff moved since: the diff on screen is to be read
   * again. */
  onBasisMoved?: () => void;
} = $props();

/** Re-read the patch once it has moved, the page's way. */
const reread = () => (typeof refresh === "string" ? invalidate(refresh) : refresh());

let busy = $state(false);
// A held patch (its generation already landed, or the server found another reason to hold it)
// is decided only with its diff in view: where no diff is shown, the action is a link to the
// page that shows it.
const held = $derived(patch.heldReason !== null && diffBasis === undefined);
// A patch held for its landed generation, of a run that still goes on, is nobody's to send yet:
// the server refuses it.
const heldLive = $derived(patch.heldUntilRunEnds === true && patch.runLive === true);

/** How an action ended: done, refused for a reason the page acts on, or failed. */
type Outcome = "done" | "refused" | "failed";

async function act(run: () => Promise<unknown>, done: string, failed: string): Promise<Outcome> {
  busy = true;
  try {
    await run();
    toast.success(done);
    await reread();
    return "done";
  } catch (e) {
    const refusal = approvalRefusal(e);
    if (refusal === null) {
      toast.error(e instanceof Error ? e.message : failed);
      return "failed";
    }
    // Where no diff is shown, a refusal that wants one points at the patch's page. The refresh
    // also turns the row's button into Review.
    const review = refusalNeedsReview(refusal) && diffBasis === undefined;
    toast.error(
      approvalRefusalMessage(refusal),
      review
        ? { action: { label: "Review", onClick: () => void goto(`/patches/${patch.id}`) } }
        : undefined,
    );
    if (refusal === "diff_basis_moved") onBasisMoved?.();
    await reread();
    return "refused";
  } finally {
    busy = false;
  }
}

// What the hook check says about approving: not while it runs, and never from here for a patch
// with more hook files than it can show.
const blocked = $derived(approveBlock(patch));

function approve(shown: string[] | null) {
  return act(
    () => approvePatch(fetch, patch.id, diffBasis, approvalHookPaths(patch, shown)),
    isLocalPatch(patch)
      ? "Patch approved. Adding it as a branch."
      : "Patch approved. Opening a change request.",
    "Failed to approve patch",
  );
}

// A patch held for its git hook files is approved only from a dialog that names them. The list is
// copied when the dialog opens: a refresh behind it changes neither what it shows nor what
// approving sends.
let confirmingApprove = $state(false);
let shownHooks = $state.raw<string[]>([]);

function startApprove() {
  const snapshot = snapshotHookFiles(patch);
  if (snapshot === null) {
    void approve(null);
    return;
  }
  shownHooks = snapshot;
  confirmingApprove = true;
}

async function submitApprove() {
  // A refusal closes the dialog too: what it showed is out of date. A plain failure keeps it open
  // to try again.
  const outcome = await approve(shownHooks);
  if (outcome !== "failed") confirmingApprove = false;
}

let confirming = $state(false);
let rejecting = $state(false);

async function submitReject() {
  rejecting = true;
  try {
    await rejectPatch(fetch, patch.id);
    toast.success("Patch rejected");
    confirming = false;
    await reread();
  } catch (e) {
    // Changed meanwhile: what the dialog asked about is out of date, so it closes and the page
    // reads the patch again.
    if (approvalRefusal(e) === "patch_changed") {
      toast.error(approvalRefusalMessage("patch_changed"));
      confirming = false;
      await reread();
      return;
    }
    toast.error(e instanceof Error ? e.message : "Failed to reject patch");
  } finally {
    rejecting = false;
  }
}
</script>

{#if patch.state === "pending_approval"}
  <Button
  variant="outline"
  {size}
  disabled={busy}
  onclick={() => {
      confirming = true;
    }}
>
    <XIcon data-icon="inline-start" />
    Reject
  </Button>
  {#if held}
    <!-- A held patch is decided with its diff in view, on its own page. -->
    <Button {size} href="/patches/{patch.id}">Review</Button>
  {:else}
  <!-- A disabled button takes no pointer, so the reason hangs on a wrapper. -->
  <span class="inline-flex" title={blocked?.label}>
  <Button {size} disabled={busy || !ready || blocked !== null || heldLive} onclick={startApprove}>
      {#if busy || blocked?.reason === "checking"}
        <Spinner data-icon="inline-start" />
      {:else}
        <CheckIcon data-icon="inline-start" />
      {/if}
      Approve
      {#if blocked}
        <span class="sr-only">. {blocked.label}</span>
      {/if}
    </Button>
</span>
  {/if}
{:else if patch.state === "failed"}
  {#if held}
    <Button variant="outline" {size} href="/patches/{patch.id}">Review</Button>
  {:else}
  <Button
  variant="outline"
  {size}
  disabled={busy || !ready || heldLive}
  onclick={() =>
      act(
        () => retryPatch(fetch, patch.id, diffBasis),
        "Patch queued for another attempt",
        "Failed to retry patch",
      )}
>
    {#if busy}
      <Spinner data-icon="inline-start" />
    {:else}
      <RotateCwIcon data-icon="inline-start" />
    {/if}
    Retry
  </Button>
  {/if}
{:else if patch.forgeUrl}
  <Button variant="outline" {size} href={patch.forgeUrl} target="_blank" rel="noreferrer">
    {patch.forgeRef
      ? threadLabel(
        patch.provider ?? providerOfThread(patch.forgeRef),
        "change_request",
        patch.forgeRef,
      )
      : "Change request"}
    <ExternalLinkIcon data-icon="inline-end" />
  </Button>
{:else if patch.forgeRef && patch.provider === "local"}
  <!-- A branch on this machine has no page to open: name it, for checking out by hand. -->
  <span class="text-muted-foreground inline-flex min-w-0 items-center gap-1.5 text-sm">
  <GitBranchIcon class="size-3.5 shrink-0" />
  <span class="truncate font-mono text-xs" title={patch.forgeRef}>{patch.forgeRef}</span>
</span>
{/if}

<AlertDialog.Root bind:open={confirming}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>
        Reject the patch for "{patch.title ?? patch.taskTitle ?? patch.branchName}"?
      </AlertDialog.Title>
      <AlertDialog.Description>
        Nothing from this patch will reach the repository. Rejection is final. The patch stays on
        record, but the only way forward is a new run.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action disabled={rejecting} onclick={submitReject}>
        {#if rejecting}
          <Spinner data-icon="inline-start" />
        {/if}
        Reject patch
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root bind:open={confirmingApprove}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>{HOOK_CONFIRM_TITLE}</AlertDialog.Title>
      <AlertDialog.Description>{HOOK_CONFIRM_BODY}</AlertDialog.Description>
    </AlertDialog.Header>
    <ul
      class="bg-muted flex max-h-60 flex-col gap-1 overflow-y-auto rounded-md px-3 py-2 font-mono text-xs">
      {#each shownHooks as file (file)}
        <li class="wrap-anywhere">{file}</li>
      {/each}
    </ul>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action disabled={busy} onclick={submitApprove}>
        {#if busy}
          <Spinner data-icon="inline-start" />
        {/if}
        Approve
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
