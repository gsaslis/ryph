<script lang="ts">
import type { CheckSuiteView, Patch } from "$lib/api/types";
import Markdown from "$lib/components/markdown/markdown.svelte";
import ThreadLabel from "$lib/components/thread-label/thread-label.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Spinner } from "$lib/components/ui/spinner";
import { isSuiteSettled } from "$lib/utils/checks";
import { shortCommit } from "$lib/utils/environments";
import { formatDateTime, formatTime } from "$lib/utils/format";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import FileDiffIcon from "@lucide/svelte/icons/file-diff";
import PaneCard from "./pane-card.svelte";
import HookWarning from "$lib/components/hook-warning/hook-warning.svelte";
import { getPatchesRefresh } from "$lib/components/tool-call/patches-context";
import {
  HOOK_CHECKING_LABEL,
  HOOK_HELD_LABEL,
  isCheckingHooks,
  isHeld,
  isLocalPatch,
} from "$lib/utils/hook-check";

let {
  patch,
  earlier,
  pushed,
  suite,
  terminal,
  showLine = false,
}: {
  patch: Patch;
  /** The versions this one replaced, newest first. */
  earlier: Patch[];
  /** It went onto a change request that was already open, rather than opening one. */
  pushed: boolean;
  /** The checks it is judged by, if any. */
  suite: CheckSuiteView | null;
  terminal: boolean;
  /** Name its line: the run shipped more than one line of work in this repo. */
  showLine?: boolean;
} = $props();

// Held for its git hook files: the warning and the decision sit in the item itself.
const held = $derived(isHeld(patch));
const checking = $derived(isCheckingHooks(patch));
const local = $derived(isLocalPatch(patch));
const refresh = getPatchesRefresh();

type Tone = "done" | "now" | "bad";
interface Step {
  key: string;
  label: string;
  at: string | null;
  tone: Tone;
  /** Where the step leads: the suite's page. */
  href?: string;
  spinner?: boolean;
  /** A quiet line under the step: what is going on while it waits. */
  note?: string;
  /** The words behind a failure. */
  detail?: string | null;
}

const stateLabel = (state: CheckSuiteView["state"]) =>
  ({
    waiting: "Checks waiting",
    queued: "Checks queued",
    running: "Checks running",
    passed: "Checks passed",
    failed: "Checks failed",
    error: "Checks errored",
    cancelled: "Checks cancelled",
  })[state];

// The patch's life in order: made, approved, delivered, checked, landed. Each step
// the record can date carries its time; the last one is where the patch stands now.
const steps = $derived.by((): Step[] => {
  const out: Step[] = [{
    key: "made",
    label: "Made by the agent",
    at: patch.createdAt,
    tone: "done",
  }];
  if (patch.approvedAt !== null) {
    out.push({
      key: "approved",
      label: patch.approvedBy?.kind === "break-glass" ? "Approved by break-glass" : "Approved",
      at: patch.approvedAt,
      tone: "done",
    });
  }
  switch (patch.state) {
    case "pending_approval":
      // Waiting on a person either way; while its files are checked for git hooks, nobody can
      // approve it yet, and the step says so under its label.
      out.push(
        held ? { key: "state", label: HOOK_HELD_LABEL, at: null, tone: "bad" } : {
          key: "state",
          label: "Waiting for approval",
          at: null,
          tone: "now",
          note: checking ? HOOK_CHECKING_LABEL : undefined,
        },
      );
      break;
    case "rejected":
      out.push({ key: "state", label: "Rejected", at: null, tone: "bad" });
      break;
    case "queued":
    case "submitting": {
      // `attempts` counts the tries begun: one more is under way while submitting, and the next
      // waits while queued.
      const attempt = patch.state === "submitting" ? patch.attempts : patch.attempts + 1;
      const doing = local ? "Adding the branch" : "Opening a change request";
      out.push({
        key: "state",
        label: attempt > 1 ? `${doing}, try ${attempt}` : doing,
        at: null,
        tone: "now",
        spinner: !terminal || patch.state === "submitting",
      });
      break;
    }
    case "failed":
      out.push({
        key: "state",
        label: patch.nextAttemptAt !== null
          ? `Failed, trying again at ${formatTime(patch.nextAttemptAt)}`
          : `Failed after ${patch.attempts} ${patch.attempts === 1 ? "try" : "tries"}`,
        at: null,
        tone: "bad",
        detail: patch.lastError,
      });
      break;
  }
  if (patch.forgeRef !== null) {
    // The thread's own label, beside it, is the link.
    out.push({ key: "opened", label: pushed ? "Pushed to" : "Opened", at: null, tone: "done" });
  } else if (patch.state === "submitted") {
    out.push({
      key: "opened",
      label: local ? "Branch added" : "Delivered",
      at: null,
      tone: "done",
    });
  }
  if (suite !== null) {
    const settled = isSuiteSettled(suite.state);
    out.push({
      key: "checks",
      label: stateLabel(suite.state),
      at: suite.finishedAt ?? suite.launchedAt ?? suite.createdAt,
      tone: suite.state === "passed"
        ? "done"
        : settled
        ? (suite.state === "cancelled" ? "done" : "bad")
        : "now",
      href: `/checks/${suite.id}`,
      spinner: suite.state === "running",
    });
  }
  if (patch.landed !== null) {
    // An unproven miss: nobody could confirm whether this patch was in the merge.
    const missed = patch.landed.unproven === true
      ? "Merged, this patch not confirmed"
      : "Merged without this patch";
    out.push({
      key: "landed",
      label: patch.landed.kind === "merged"
        ? "Merged"
        : patch.landed.kind === "missed"
        ? missed
        : "Closed without merging",
      at: patch.landed.at,
      tone: "done",
    });
  }
  if (patch.state === "superseded") {
    out.push({ key: "superseded", label: "Replaced by a newer version", at: null, tone: "done" });
  }
  return out;
});

let showEarlier = $state(false);

/** The `after:` overlay that makes the title link cover the whole row. */
const rowLink =
  "outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring";
</script>

<div class="flex items-baseline gap-2">
  <a href="/patches/{patch.id}" class={["min-w-0 flex-1 font-medium", rowLink]}
    title="View the diff">
    Opened a patch
  </a>
  <time datetime={patch.createdAt} title={formatDateTime(patch.createdAt)}
    class="text-muted-foreground relative z-10 shrink-0 text-xs tabular-nums">
    {formatTime(patch.createdAt)}
  </time>
</div>
<div class="text-muted-foreground relative z-10 truncate font-mono text-xs"
  title={patch.branchName}>
  {patch.path}/ on {patch.branchName} at {shortCommit(patch.headSha)}
</div>

<PaneCard>
  <p class="font-medium">{patch.title ?? `Patch to ${patch.path}/`}</p>
  {#if patch.description}
    <Markdown compact content={patch.description} />
  {/if}
</PaneCard>

{#if held}
  <HookWarning {patch} {refresh} diffLink class="relative z-10 my-0.5" />
{/if}

<!-- Its life so far, one line a step on a short rail of its own; the newest step is where it
     stands, drawn in full colour. -->
<ol class="relative z-10 flex flex-col py-0.5">
  {#each steps as step, i (step.key)}
    {@const last = i === steps.length - 1}
    <li
      class="relative grid grid-cols-[0.75rem_minmax(0,1fr)_auto] items-baseline gap-x-2 pb-1.5 text-xs last:pb-0 before:absolute before:top-[0.6rem] before:bottom-[-0.15rem] before:left-[0.375rem] before:w-px before:-translate-x-1/2 before:bg-border last:before:hidden"
    >
      <span
        class={[
          "relative top-px size-1.5 justify-self-center rounded-full",
          step.tone === "bad"
            ? "bg-destructive"
            : last
            ? "bg-foreground"
            : "bg-muted-foreground/50",
        ]}
      ></span>
      <span
        class={[
          "flex min-w-0 items-center gap-1.5",
          step.tone === "bad"
            ? "text-destructive"
            : last
            ? "text-foreground"
            : "text-muted-foreground",
        ]}
      >
        {#if step.spinner}
          <Spinner class="size-3" />
        {/if}
        {#if step.href}
          <a
            href={step.href}
            class="truncate underline-offset-4 hover:underline"
          >
            {step.label}
          </a>
        {:else}
          <span class="truncate">{step.label}</span>
        {/if}
        {#if step.key === "opened" && patch.forgeRef !== null}
          <ThreadLabel
            thread={patch.forgeRef}
            url={patch.forgeUrl}
            provider={patch.provider ?? undefined}
          />
        {/if}
      </span>
      {#if step.at !== null}
        <time datetime={step.at} title={formatDateTime(step.at)}
          class="text-muted-foreground tabular-nums">
          {formatTime(step.at)}
        </time>
      {:else}
        <span></span>
      {/if}
      {#if step.note}
        <p class="text-muted-foreground col-start-2 col-end-4 flex items-center gap-1.5 pt-0.5">
          <Spinner class="size-3" />
          {step.note}
        </p>
      {/if}
      {#if step.detail}
        <p class="text-destructive/80 col-start-2 col-end-4 line-clamp-3 pt-0.5 wrap-anywhere">
          {step.detail}
        </p>
      {/if}
    </li>
  {/each}
</ol>

<div class="relative z-10 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
  {#if earlier.length > 0}
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground flex items-center gap-1 underline-offset-4 hover:underline"
      aria-expanded={showEarlier}
      onclick={() => (showEarlier = !showEarlier)}
    >
      <ChevronRightIcon class={["size-3.5 transition-transform", showEarlier && "rotate-90"]} />
      {earlier.length} earlier {earlier.length === 1 ? "version" : "versions"}
    </button>
  {/if}
  {#if showLine}
    <Badge variant="outline" class="font-mono"
      title="Its line of work: a branch and change request of its own">{patch.line}</Badge>
  {/if}
  {#if patch.generation > 1}
    <Badge variant="outline" title="The branch this patch started">#{patch.generation}</Badge>
  {/if}
  <Button href="/patches/{patch.id}" variant="outline" size="xs" class="ml-auto">
    <FileDiffIcon data-icon="inline-start" />
    Diff
  </Button>
</div>

{#if showEarlier}
  <!-- The versions this one replaced, each still openable for its own diff. -->
  <ul class="relative z-10 flex flex-col border-t pt-1.5">
    {#each earlier as version (version.id)}
      <li>
        <a
          href="/patches/{version.id}"
          class="hover:bg-sidebar-accent text-muted-foreground hover:text-foreground -mx-1 flex items-baseline gap-2 rounded-md px-1 py-1 text-xs"
        >
          <span class="min-w-0 flex-1 truncate">{version.title ?? `Patch to ${version.path}/`}</span>
          <span class="font-mono">{shortCommit(version.headSha)}</span>
          <time datetime={version.createdAt} title={formatDateTime(version.createdAt)}
            class="tabular-nums">
            {formatTime(version.createdAt)}
          </time>
        </a>
      </li>
    {/each}
  </ul>
{/if}
