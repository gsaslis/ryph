<script lang="ts">
import { goto, invalidate, replaceState } from "$app/navigation";
import { page } from "$app/state";
import { checkLogHref, getCheckLog, rerunCheckSuite } from "$lib/api/checks";
import type { CheckView } from "$lib/api/types";
import CheckStateBadge from "$lib/components/check-state-badge/check-state-badge.svelte";
import CheckStateIcon from "$lib/components/check-state-icon/check-state-icon.svelte";
import CopyButton from "$lib/components/copy-button/copy-button.svelte";
import LogFindBar from "$lib/components/log-find/log-find-bar.svelte";
import { LogFind } from "$lib/components/log-find/log-find.svelte";
import LogView from "$lib/components/log-view/log-view.svelte";
import PageTitle from "$lib/components/page-title/page-title.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Empty from "$lib/components/ui/empty";
import { Separator } from "$lib/components/ui/separator";
import { Spinner } from "$lib/components/ui/spinner";
import { Toggle } from "$lib/components/ui/toggle";
import { can } from "$lib/utils/auth/capabilities";
import {
  canRerunSuite,
  checkDurationMs,
  checkTone,
  countsLabel,
  definedAtLabel,
  isSuiteSettled,
  partialLabel,
  ryphChange,
  suiteCounts,
  suiteImageLabel,
  timeoutLabel,
  watchedChange,
} from "$lib/utils/checks";
import { shortCommit } from "$lib/utils/environments";
import { forgeRepoLabel, localRepoName, providerOfRepoRef } from "$lib/utils/forge";
import { formatDateTime, formatElapsed } from "$lib/utils/format";
import { liveClock } from "$lib/utils/live-clock.svelte";
import { refreshWhileLive } from "$lib/utils/live-refresh.svelte.js";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
import ScrollTextIcon from "@lucide/svelte/icons/scroll-text";
import WrapTextIcon from "@lucide/svelte/icons/wrap-text";
import { untrack } from "svelte";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";
import InheritedBadge from "$lib/components/inherited-badge/inherited-badge.svelte";

let { data }: PageProps = $props();

const suite = $derived(data.suite);
const clock = liveClock(() => suite.checks.some((check) => check.state === "running"));
// Named by what was checked: the repository, then the commit beside it. GitHub's and GitLab's
// name is the address's last part, the owner (or groups) said again in the line below; a local
// repo's is its folder name, the full path below; Radicle's address is shortened. The provider is
// the suite's own; only an older suite without one is read off its address, which never answers
// GitLab.
const provider = $derived(
  suite.provider ?? (suite.repoRef ? providerOfRepoRef(suite.repoRef) : null),
);
const repoTitle = $derived(
  suite.repoRef === null || provider === null
    ? suite.connectedRepoId
    : provider === "github" || provider === "gitlab"
    ? (suite.repoRef.split("/").at(-1) ?? suite.repoRef)
    : provider === "local"
    ? localRepoName(suite.repoRef)
    : forgeRepoLabel({ provider, repoRef: suite.repoRef }),
);
// Every poll hands the page a new suite object; only another suite (Run again landing on a new
// one, back and forward) starts the chosen check and the find over.
const suiteId = $derived(data.suite.id);
const settled = $derived(isSuiteSettled(suite.state));
const counts = $derived(suiteCounts(suite));
const partial = $derived(partialLabel(suite));
const ryph = $derived(ryphChange(suite));
const mayRerun = $derived(canRerunSuite(suite.state) && can(data.user, "patches:review"));
const olderLink = $derived(
  data.linkedGeneration !== null && data.linkedGeneration < suite.generation,
);

refreshWhileLive("app:check-suite", () => !isSuiteSettled(data.suite.state));

// The check on the right: the one the address names, else the first that failed, else the one
// still running, else the first. Kept in the address so a link opens on the same check.
let named = $derived.by(() => {
  void suiteId;
  return untrack(() => page.url.searchParams.get("check"));
});
// The check the page chose for the reader while none failed, kept: recomputed on every poll, the
// pane would jump from a check that just finished to the next one running. A failure still wins
// over it, as a click or the address wins over both. Pinned in an effect because a derived may
// not write state; `.pre` so the pin lands before the pane is drawn again. Starts over per suite.
let pinned = $derived.by((): string | null => {
  void suiteId;
  return null;
});
const selected = $derived.by((): CheckView | null => {
  return suite.checks.find((c) => c.name === named) ??
    suite.checks.find((c) => checkTone(c.state) === "failed") ??
    suite.checks.find((c) => c.name === pinned) ??
    suite.checks.find((c) => c.state === "running") ??
    suite.checks[0] ??
    null;
});
$effect.pre(() => {
  if (pinned === null && selected !== null) pinned = selected.name;
});

function select(name: string) {
  named = name;
  find.index = 0;
  const url = new URL(page.url);
  url.searchParams.set("check", name);
  replaceState(url, page.state);
}

// Whole logs, read when a check is shown and kept per generation: a re-run is new output under
// the same name. A check still running has no log yet; its read waits until it settles.
type LogRead = { text: string } | { error: string } | "loading";
let logs = $state<Record<string, LogRead>>({});
const logKey = (name: string) => `${suite.id}:${suite.generation}:${name}`;

async function readLog(name: string) {
  const key = logKey(name);
  logs[key] = "loading";
  try {
    logs[key] = { text: await getCheckLog(fetch, suite.id, suite.generation, name) };
  } catch (e) {
    logs[key] = { error: e instanceof Error ? e.message : "The log could not be read" };
  }
}

$effect(() => {
  if (selected === null || !selected.hasLog) return;
  if (logs[logKey(selected.name)] === undefined) void readLog(selected.name);
});

const read = $derived(selected === null ? undefined : logs[logKey(selected.name)]);
const whole = $derived(read !== undefined && read !== "loading" && "text" in read ? read : null);
const readError = $derived(
  read !== undefined && read !== "loading" && "error" in read ? read.error : null,
);
// The whole log. The tail the suite carries stands in only when the whole could not be read, or
// there is none to read: shown while the whole is on its way, it would only flash.
const shownLog = $derived(
  whole !== null
    ? whole.text.trimEnd()
    : readError !== null || !selected?.hasLog
    ? selected?.logTail?.trimEnd() ?? null
    : null,
);

let wrap = $state(true);

// Find in the log. The query stays as checks are switched, so one search can be run through each;
// another suite starts it over.
const find = $derived.by(() => {
  void suiteId;
  return new LogFind(() => shownLog);
});

let rerunning = $state(false);
async function handleRerun() {
  rerunning = true;
  try {
    const next = await rerunCheckSuite(fetch, suite.id);
    toast.success("Running the checks again");
    // A suite whose services changed runs again as a different suite.
    if (next.id !== suite.id) await goto(`/checks/${next.id}`);
    else await invalidate("app:check-suite");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to run the checks again");
  } finally {
    rerunning = false;
  }
}
</script>

<svelte:head>
  <title>{repoTitle} at {shortCommit(suite.commit)} · Ryph</title>
</svelte:head>

<!-- Logs want every column the panel has: the page takes the panel's full width, past the
     column the layout keeps other pages to. -->
<!-- On a wide screen the page is exactly the viewport's height below the header, so the log
     scrolls inside its pane and nothing else moves. Its foot sits the side gutter's width above
     the panel's edge, as its right side does, not the taller gutter other pages end on. -->
<div
  class="-mx-(--bleed) flex flex-col gap-6 [--bleed:calc((100cqw_-_100%)_/_2)] lg:-mb-[calc(var(--page-gutter-y)_-_var(--page-gutter))] lg:h-[calc(100svh_-_2_*_var(--panel-cap)_-_--spacing(14)_-_var(--page-gutter-y)_-_var(--page-gutter)_-_1px)]"
>
  <PageTitle title={repoTitle}>
    {#snippet aside()}
      <span
        class="text-muted-foreground font-mono text-xl tracking-tight"
        title={suite.commit}
      >
        {shortCommit(suite.commit)}
      </span>
    {/snippet}
    {#snippet actions()}
      {#if mayRerun}
        <Button variant="outline" size="sm" disabled={rerunning} onclick={handleRerun}>
          {#if rerunning}
            <Spinner data-icon="inline-start" />
          {:else}
            <RotateCwIcon data-icon="inline-start" />
          {/if}
          Run again
        </Button>
      {/if}
    {/snippet}
    {#snippet description()}
      {#if data.branch}
        <span class="font-mono">{data.branch}</span> on
      {/if}
      {suite.repoRef === null || provider === null
      ? suite.connectedRepoId
      : forgeRepoLabel({ provider, repoRef: suite.repoRef })},
      {#if settled && suite.finishedAt}
        finished {formatDateTime(suite.finishedAt)}.
      {:else}
        asked for {formatDateTime(suite.createdAt)}.
      {/if}
    {/snippet}
  </PageTitle>

  {#if olderLink}
    <p class="text-muted-foreground text-sm">
      This link is for an earlier run of these checks. Showing the latest run.
    </p>
  {/if}

  <div class="grid items-start gap-6 lg:min-h-0 lg:flex-1 lg:grid-cols-[17rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
    <!-- The checks, and what they ran against. -->
    <aside class="flex flex-col gap-5 lg:max-h-full lg:overflow-y-auto">
      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <CheckStateBadge state={suite.state} />
          <span class="text-muted-foreground text-sm">{countsLabel(counts)}</span>
        </div>
        {#if partial !== null || suite.generation > 1}
          <div class="flex flex-wrap gap-1.5">
            {#if partial !== null}
              <Badge variant="outline" title="A run of some of the checks">{partial}</Badge>
            {/if}
            {#if suite.generation > 1}
              <Badge variant="outline" title="Times these checks have run">
                Run {suite.generation}
              </Badge>
            {/if}
          </div>
        {/if}
      </div>

      {#if suite.checks.length > 0}
        <nav aria-label="Checks" class="flex flex-col gap-0.5">
          {#each suite.checks as item (item.name)}
            {@const duration = checkDurationMs(item, clock.now)}
            {@const current = selected?.name === item.name}
            <button
              type="button"
              aria-current={current ? "true" : undefined}
              onclick={() => select(item.name)}
              class={[
                "focus-visible:ring-ring/50 flex h-9 items-center gap-2.5 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-[3px]",
                current ? "bg-muted font-medium" : "hover:bg-muted/60",
              ]}
            >
              <CheckStateIcon state={item.state} />
              <span class="min-w-0 flex-1 truncate font-mono text-[13px]">{item.name}</span>
              {#if item.inherited}
                <span class="text-muted-foreground shrink-0 text-xs">Inherited</span>
              {/if}
              {#if duration !== null}
                <span class="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {formatElapsed(duration)}
                </span>
              {/if}
            </button>
          {/each}
        </nav>
      {/if}

      {#if suite.reason}
        <!-- The platform's own account of what went wrong, which can be technical. -->
        <p class="text-muted-foreground text-xs whitespace-pre-line">{suite.reason}</p>
      {/if}

      <Separator />

      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        <dt class="text-muted-foreground">Defined in</dt>
        <dd class="min-w-0">
          <code class="break-all">{suite.checksPath}</code>
          <span class="text-muted-foreground block font-mono">{definedAtLabel(suite)}</span>
        </dd>
        <dt class="text-muted-foreground">Ran on</dt>
        <dd
          class="min-w-0 truncate font-mono"
          title={suite.environment.image ?? suite.environment.key}
        >
          {suiteImageLabel(suite)}
        </dd>
      </dl>

      {#if ryph === "changed"}
        <p class="text-muted-foreground text-xs">
          This change edits <code>.ryph/</code>. The checks ran as the base defines them.
        </p>
      {:else if ryph === "unknown"}
        <p class="text-muted-foreground text-xs">
          Could not tell whether this change edits <code>.ryph/</code>.
        </p>
      {/if}
    </aside>

    <!-- The selected check and its log. -->
    {#if selected !== null}
      {@const duration = checkDurationMs(selected, clock.now)}
      {@const watched = watchedChange(selected)}
      {@const key = logKey(selected.name)}
      <section
        aria-label="Log of {selected.name}"
        class="bg-card flex h-[75svh] min-h-96 flex-col overflow-hidden rounded-xl border lg:h-full"
      >
        <header class="flex flex-col gap-3 border-b p-4">
          <div class="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
            <h2 class="font-mono text-base font-medium">{selected.name}</h2>
            <CheckStateBadge state={selected.state} />
            {#if selected.exitCode !== null && selected.exitCode !== 0}
              <span class="text-muted-foreground text-xs">Exit {selected.exitCode}</span>
            {/if}
            {#if duration !== null}
              <span class="text-muted-foreground text-xs tabular-nums">
                {formatElapsed(duration)}
              </span>
            {/if}
            {#if selected.inherited}
              <InheritedBadge />
            {/if}
            {#if watched === "changed"}
              <Badge variant="outline" title="The change touched files this check depends on">
                Watched files changed
              </Badge>
            {:else if watched === "unknown"}
              <Badge variant="outline" title="Could not tell which files the change touched">
                Changed files unknown
              </Badge>
            {/if}
            <div class="ml-auto flex items-center gap-1">
              <!-- There from the first render for any check with a log, and live once it is here:
                   appearing with it would push everything below down. -->
              {#if selected.hasLog || shownLog !== null}
                <LogFindBar {find} disabled={shownLog === null} />
                <Toggle
                  size="sm"
                  class="size-8 px-0"
                  disabled={shownLog === null}
                  bind:pressed={wrap}
                  aria-label="Wrap long lines"
                  title="Wrap long lines"
                >
                  <WrapTextIcon />
                </Toggle>
                <CopyButton
                  size="icon-sm"
                  value={shownLog ?? ""}
                  disabled={shownLog === null}
                  label="Copy the log"
                  what="Log copied"
                />
              {/if}
              {#if selected.hasLog}
                <Button
                  variant="ghost"
                  size="sm"
                  href={checkLogHref(suite.id, suite.generation, selected.name)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLinkIcon data-icon="inline-start" />
                  Raw log
                </Button>
              {/if}
            </div>
          </div>

          <div class="flex flex-col gap-1.5">
            <pre
              class="bg-muted/60 max-h-24 overflow-auto rounded-md px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap">{selected.run}</pre>
            <p class="text-muted-foreground text-xs">
              Times out after {timeoutLabel(selected.timeoutSeconds)}.
              {#if selected.services.length > 0}
                Services: {selected.services.join(", ")}.
              {/if}
            </p>
            {#if readError !== null && shownLog !== null}
              <p class="text-destructive text-xs">
                Showing the last lines only. {readError}
                <Button
                  variant="link"
                  size="sm"
                  class="h-auto px-0 text-xs"
                  onclick={() => readLog(selected.name)}
                >
                  Try again
                </Button>
              </p>
            {/if}
          </div>
        </header>

        <!-- A check's output is the head commit's own text: it is only ever rendered as text. -->
        {#if shownLog !== null}
          {#key key}
            <LogView text={shownLog} {wrap} line={find.line} class="flex-1" />
          {/key}
        {:else if read === "loading" || (read === undefined && selected.hasLog)}
          <!-- Usually here in a moment (and on the server, not asked for yet): an empty pane,
               rather than a state that only flashes. -->
          <div class="flex-1"></div>
        {:else}
          <Empty.Root class="flex-1 border-0">
            <Empty.Header>
              <Empty.Media variant="icon">
                {#if selected.state === "running"}
                  <Spinner />
                {:else}
                  <ScrollTextIcon />
                {/if}
              </Empty.Media>
              <Empty.Title>
                {#if selected.state === "running"}
                  Running
                {:else if selected.state === "queued"}
                  Not started yet
                {:else}
                  No log
                {/if}
              </Empty.Title>
              <Empty.Description>
                {#if readError !== null}
                  {readError}
                {:else if selected.state === "running" || selected.state === "queued"}
                  The log shows here once this check finishes.
                {:else}
                  This check left no output.
                {/if}
              </Empty.Description>
            </Empty.Header>
            {#if readError !== null}
              <Empty.Content>
                <Button variant="outline" size="sm" onclick={() => readLog(selected.name)}>
                  Try again
                </Button>
              </Empty.Content>
            {/if}
          </Empty.Root>
        {/if}
      </section>
    {/if}
  </div>
</div>
