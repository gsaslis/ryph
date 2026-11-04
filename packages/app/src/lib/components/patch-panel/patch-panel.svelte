<script lang="ts">
import type { Patch } from "$lib/api/types";
import HookWarning from "$lib/components/hook-warning/hook-warning.svelte";
import ExpandableText from "$lib/components/expandable-text/expandable-text.svelte";
import Markdown from "$lib/components/markdown/markdown.svelte";
import PatchStateBadge from "$lib/components/patch-state-badge/patch-state-badge.svelte";
import LandedBadge from "$lib/components/patch-state-badge/landed-badge.svelte";
import ThreadLabel from "$lib/components/thread-label/thread-label.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Spinner } from "$lib/components/ui/spinner";
import { shortCommit } from "$lib/utils/environments";
import {
  HOOK_CHECKING_LABEL,
  hookCheckNotice,
  isCheckingHooks,
  isHeld,
} from "$lib/utils/hook-check";
import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
import FileDiffIcon from "@lucide/svelte/icons/file-diff";

let { patchId, patch, repo, headSha, generation, title, description }: {
  patchId: string;
  /** The patch as the page holds it now; null where the page holds none, and then the card is
   * what the call itself carried. */
  patch: Patch | null;
  /** The repo as the call named it: its directory in the run's checkout. */
  repo: string | null;
  headSha: string | null;
  generation: number | null;
  title: string | null;
  description: string | null;
} = $props();

const shownTitle = $derived(patch?.title ?? title);
const shownDescription = $derived(patch?.description ?? description);
const sha = $derived(patch?.headSha ?? headSha);
const gen = $derived(patch?.generation ?? generation);
</script>

<!-- A patch's description is the agent's own text: rendered as markdown, never as markup. -->
<div class="flex flex-col gap-3 rounded-lg border p-3 text-sm">
  <div class="flex flex-wrap items-center gap-2">
    {#if patch}
      <PatchStateBadge state={patch.state} held={patch.heldReason} />
      {#if patch.landed}
        <LandedBadge landed={patch.landed} />
      {/if}
    {/if}
    {#if repo || sha}
      <span class="font-mono text-xs" title={sha ?? undefined}>
        {patch?.path ?? repo}{sha ? ` at ${shortCommit(sha)}` : ""}
      </span>
    {/if}
    {#if gen !== null && gen > 1}
      <Badge variant="outline" title="Which branch of the run's work this is">#{gen}</Badge>
    {/if}
    {#if patch?.forgeRef}
      <ThreadLabel thread={patch.forgeRef} url={patch.forgeUrl} class="text-xs" />
    {/if}
    <Button variant="outline" size="xs" href="/patches/{patchId}" class="ml-auto">
      <FileDiffIcon data-icon="inline-start" />
      View diff
    </Button>
  </div>

  {#if patch && isHeld(patch)}
    <!-- Approve and Reject are on the run's notice and in its details: this one points at the
         diff. Announced as a status, as every transcript row is redrawn on scrolling back. -->
    <HookWarning {patch} diffLink role="status" />
  {:else if patch && isCheckingHooks(patch)}
    <p class="text-muted-foreground flex items-center gap-1.5 text-xs">
      <Spinner class="size-3" />
      {HOOK_CHECKING_LABEL}
    </p>
  {:else if patch && hookCheckNotice(patch)}
    <p class="text-muted-foreground flex items-start gap-1.5 text-xs">
      <CircleAlertIcon class="mt-0.5 size-3 shrink-0" />
      <span>{hookCheckNotice(patch)}</span>
    </p>
  {/if}
  {#if shownTitle}
    <p class="font-medium">{shownTitle}</p>
  {/if}
  {#if shownDescription}
    <ExpandableText maxHeight={240}>
      <Markdown content={shownDescription} class="text-sm" />
    </ExpandableText>
  {/if}
</div>
