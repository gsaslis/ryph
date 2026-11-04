<script lang="ts">
import { browser } from "$app/environment";
import { ApiError } from "$lib/api/call";
import { type ApprovalBasis, getPatchDiff } from "$lib/api/patches";
import { isPatchAdvancing } from "$lib/api/types";
import CheckStateBadge from "$lib/components/check-state-badge/check-state-badge.svelte";
import ForgeRepoLabel from "$lib/components/forge-repo-label/forge-repo-label.svelte";
import Markdown from "$lib/components/markdown/markdown.svelte";
import PageTitle from "$lib/components/page-title/page-title.svelte";
import HookWarning from "$lib/components/hook-warning/hook-warning.svelte";
import PatchActions from "$lib/components/patch-actions/patch-actions.svelte";
import PatchDiff from "$lib/components/patch-diff/patch-diff.svelte";
import PatchStateBadge from "$lib/components/patch-state-badge/patch-state-badge.svelte";
import LandedBadge from "$lib/components/patch-state-badge/landed-badge.svelte";
import * as Alert from "$lib/components/ui/alert";
import { Button } from "$lib/components/ui/button";
import { Separator } from "$lib/components/ui/separator";
import { Skeleton } from "$lib/components/ui/skeleton";
import { Spinner } from "$lib/components/ui/spinner";
import { countsLabel, isSuiteSettled } from "$lib/utils/checks";
import { shortCommit } from "$lib/utils/environments";
import { formatDateTime, formatRelativeTime } from "$lib/utils/format";
import { diffBaseBranch } from "$lib/utils/patch-diff";
import {
  HOOK_CHECKING_LABEL,
  hookCheckNotice,
  isCheckingHooks,
  isHeld,
} from "$lib/utils/hook-check";
import { refreshWhileLive } from "$lib/utils/live-refresh.svelte.js";
import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
import GitBranchIcon from "@lucide/svelte/icons/git-branch";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const patch = $derived(data.patch);
const title = $derived(patch.title ?? patch.taskTitle ?? patch.branchName);
const about = $derived(patch.description ?? patch.summary);
/** The control plane's words, as a sentence on the page. */
const sentence = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? "" : ".");

// Polled while it moves, and while it waits for a decision: what its diff is measured from can
// move then too, and the reviewer must see that before approving.
refreshWhileLive(
  "app:patch",
  () =>
    isPatchAdvancing(data.patch) || data.patch.state === "pending_approval" ||
    data.patch.hooksPending ||
    (data.patch.checks !== null && !isSuiteSettled(data.patch.checks.state)),
);

// Read once per patch and what it is measured from, not on every poll: these are their own
// deriveds, so a poll handing over equal values re-reads nothing, and one where the earlier patch
// it follows or the change request it goes onto moved reads it again. `attempt` re-reads on
// asking again after a failure, and after an approval refused because the diff moved (a
// force-push of the branch it lands on moves it with nothing here changing).
const patchId = $derived(data.patch.id);
const headSha = $derived(data.patch.headSha);
const basis = $derived(
  data.diffBasis === null
    ? ""
    : `${data.diffBasis.mode}|${data.diffBasis.targetRef}|${data.diffBasis.sincePatchId ?? ""}`,
);
let attempt = $state(0);
const diff = $derived.by(() => {
  void attempt;
  void headSha;
  void basis;
  return browser ? getPatchDiff(fetch, patchId) : null;
});

// What approving decides on is the diff on screen: approving waits until the one for the current
// basis has loaded, and names the basis it was measured with and the commit it was measured from,
// both as the diff itself reported them, so an approval is refused if either moved since. Kept
// with a token for the read it came from (not the read, which holds the whole diff) and shown
// only while that read is the current one, so a diff read again clears it in the same render
// that shows it loading.
const reading = $derived.by(() => {
  void diff;
  return {};
});
let loaded = $state.raw<{ reading: object; basis: NonNullable<ApprovalBasis> } | null>(null);
$effect(() => {
  const pending = diff;
  const token = reading;
  void pending?.then(
    ({ mode, targetRef, sincePatchId, baseSha }) => {
      if (reading === token) {
        loaded = { reading: token, basis: { mode, targetRef, sincePatchId, baseSha } };
      }
    },
    () => {},
  );
});
const shown = $derived(loaded !== null && loaded.reading === reading ? loaded.basis : null);
</script>

<svelte:head>
  <title>{title} · Patches · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-8">
  <div class="flex flex-col gap-4">
    <PageTitle {title}>
      {#snippet aside()}
        <span class="text-muted-foreground font-mono text-xl tracking-tight" title={patch.headSha}>
          {shortCommit(patch.headSha)}
        </span>
      {/snippet}
      {#snippet actions()}
        <PatchActions
          {patch}
          size="default"
          refresh="app:patch"
          diffBasis={shown}
          ready={shown !== null}
          onBasisMoved={() => {
            attempt++;
          }}
        />
      {/snippet}
      {#snippet description()}
        <span class="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <ForgeRepoLabel
            repoRef={patch.repoRef}
            provider={patch.provider ?? undefined}
            fallback={patch.connectedRepoId}
          />
          <GitBranchIcon class="ml-1 size-3.5 shrink-0" />
          <span class="font-mono">{patch.branchName}</span>
        </span>
      {/snippet}
    </PageTitle>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <span class="flex items-center gap-1.5">
        <PatchStateBadge state={patch.state} held={patch.heldReason} />
        {#if patch.landed}
          <LandedBadge landed={patch.landed} />
        {/if}
      </span>
      {#if patch.checks}
        <a
          href="/checks/{patch.checks.suiteId}"
          class="flex items-center gap-2 underline-offset-4 hover:underline"
        >
          <CheckStateBadge state={patch.checks.state} />
          <span class="text-muted-foreground">{countsLabel(patch.checks)}</span>
        </a>
      {/if}
      <span class="text-muted-foreground">
        {#if patch.agentName}
          By {patch.agentName}
          {#if patch.taskTitle}
            for <a href="/tasks/{patch.taskId}" class="text-foreground underline-offset-4 hover:underline">
              {patch.taskTitle}
            </a>
          {/if}
        {:else if patch.taskTitle}
          For <a href="/tasks/{patch.taskId}" class="text-foreground underline-offset-4 hover:underline">
            {patch.taskTitle}
          </a>
        {/if}
      </span>
      <span class="text-muted-foreground" title={formatDateTime(patch.createdAt)}>
        Created {formatRelativeTime(patch.createdAt)}
      </span>
    </div>
  </div>

  {#if isHeld(patch)}
    <!-- Approve and Reject are the page's own, above: approving still names the files. -->
    <HookWarning {patch} />
  {:else if isCheckingHooks(patch)}
    <p class="text-muted-foreground flex items-center gap-1.5 text-sm">
      <Spinner class="size-3.5" />
      {HOOK_CHECKING_LABEL}
    </p>
  {:else if hookCheckNotice(patch)}
    <Alert.Root>
      <CircleAlertIcon />
      <Alert.Description>{hookCheckNotice(patch)}</Alert.Description>
    </Alert.Root>
  {/if}
  {#if patch.state === "failed" && patch.lastError}
    <Alert.Root variant="destructive">
      <CircleAlertIcon />
      <Alert.Title>
        Opening the change request failed{patch.attempts > 1 ? ` ${patch.attempts} times` : ""}
      </Alert.Title>
      <Alert.Description>{patch.lastError}</Alert.Description>
    </Alert.Root>
  {/if}
  {#if patch.heldReason && patch.state === "pending_approval"}
    <Alert.Root>
      <CircleAlertIcon />
      <Alert.Description>
        <span>{patch.heldReason}</span>
        {#if patch.heldUntilRunEnds}
          {#if patch.runLive}
            <span>Its run can send a replacement. Message the run to have it submit now.</span>
          {:else}
            <span>Its run has ended. {patch.heldDestination ?? ""}</span>
          {/if}
        {/if}
      </Alert.Description>
    </Alert.Root>
  {/if}
  {#if patch.supersededByPatchId}
    <Alert.Root>
      <Alert.Title>A newer patch replaced this one</Alert.Title>
      <Alert.Description>
        <span>
          <a href="/patches/{patch.supersededByPatchId}" class="underline underline-offset-4">
            Open the newer patch
          </a>. An approval of this one does not carry over to it.
        </span>
      </Alert.Description>
    </Alert.Root>
  {/if}

  {#if about || patch.commits.length > 0}
    <div class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_24rem]">
      {#if about}
        <Markdown content={about} class="max-w-3xl" />
      {/if}
      {#if patch.commits.length > 0}
        <section class={["flex flex-col gap-2", !about && "lg:col-span-2"]}>
          <h2 class="text-sm font-medium">
            {patch.commits.length}
            {patch.commits.length === 1 ? "commit" : "commits"}
          </h2>
          <ol class="flex flex-col gap-1 text-sm">
            {#each patch.commits as commit (commit.sha)}
              <li class="flex items-baseline gap-2.5">
                <span class="text-muted-foreground shrink-0 font-mono text-xs">
                  {shortCommit(commit.sha)}
                </span>
                <span class="min-w-0">{commit.subject}</span>
              </li>
            {/each}
          </ol>
        </section>
      {/if}
    </div>
  {/if}

  <Separator />

  {#if diff === null}
    {@render loading()}
  {:else}
    {#await diff}
      {@render loading()}
    {:then read}
      {@const on = diffBaseBranch(read)}
      <p class="text-muted-foreground -mt-4 text-sm">
        {#if read.sincePatchId !== null}
          What this patch adds to
          <a href="/patches/{read.sincePatchId}" class="text-foreground underline underline-offset-4"
          >the previous one</a>, since
        {:else}
          Changes since
        {/if}
        <span class="text-foreground font-mono" title={read.baseSha}>{shortCommit(read.baseSha)}</span
        >{#if on}{" "}on <span class="text-foreground font-mono break-all">{on}</span>{/if}.
      </p>
      <PatchDiff
        id="{read.baseSha}-{read.headSha}"
        diff={read.diff}
        truncated={read.truncated}
        omitted={read.omitted}
        moreOmitted={read.moreOmitted}
      />
    {:catch e}
      <!-- 409 and 410 are final: asking again changes nothing (the patch's stored copy or the
           branch it lands on gone, its repo no longer connected, nothing left to compare it
           with), and the control plane's words say which. Anything else is the forge not
           answering, worth another try. -->
      {@const final = e instanceof ApiError && (e.status === 409 || e.status === 410)}
      {@const why = e instanceof ApiError && e.message ? sentence(e.message) : null}
      <Alert.Root variant={final ? "default" : "destructive"}>
        <CircleAlertIcon />
        <Alert.Title>
          {final ? "This diff can't be shown" : "The diff couldn't be loaded"}
        </Alert.Title>
        <Alert.Description class="flex flex-col items-start gap-3">
          {#if final}
            {why ?? "This patch has nothing left to compare with."}
          {:else}
            Try again in a moment.
            <Button
              variant="outline"
              size="sm"
              onclick={() => {
                attempt++;
              }}
            >
              Try again
            </Button>
          {/if}
        </Alert.Description>
      </Alert.Root>
    {/await}
  {/if}
</div>

{#snippet loading()}
  <div class="flex flex-col gap-4">
  <Skeleton class="h-8 w-48" />
  <div class="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
    <Skeleton class="hidden h-80 lg:block" />
    <div class="flex flex-col gap-3">
      <Skeleton class="h-48" />
      <Skeleton class="h-32" />
    </div>
  </div>
</div>
{/snippet}
