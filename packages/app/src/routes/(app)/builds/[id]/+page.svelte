<script lang="ts">
import { goto } from "$app/navigation";
import { ApiError } from "$lib/api/call";
import { environmentLogHref, getEnvironmentLog, rebuildEnvironment } from "$lib/api/environments";
import BuildStatusBadge from "$lib/components/build-status-badge/build-status-badge.svelte";
import CopyButton from "$lib/components/copy-button/copy-button.svelte";
import LogFindBar from "$lib/components/log-find/log-find-bar.svelte";
import { LogFind } from "$lib/components/log-find/log-find.svelte";
import LogView from "$lib/components/log-view/log-view.svelte";
import Markdown from "$lib/components/markdown/markdown.svelte";
import PageTitle from "$lib/components/page-title/page-title.svelte";
import * as Alert from "$lib/components/ui/alert";
import SetupWarnings from "$lib/components/environment-panel/setup-warnings.svelte";
import { Button } from "$lib/components/ui/button";
import * as Empty from "$lib/components/ui/empty";
import { Separator } from "$lib/components/ui/separator";
import { Spinner } from "$lib/components/ui/spinner";
import { Toggle } from "$lib/components/ui/toggle";
import { can } from "$lib/utils/auth/capabilities";
import {
  buildDurationMs,
  buildKindLabel,
  buildProgress,
  formatBytes,
  isBuildActive,
  machineLabel,
  shortCommit,
  shortImage,
  toolchainEntries,
  triggerLabel,
} from "$lib/utils/environments";
import { forgeRepoLabel } from "$lib/utils/forge";
import { formatDateTime, formatElapsed } from "$lib/utils/format";
import { refreshWhileLive } from "$lib/utils/live-refresh.svelte.js";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
import ScrollTextIcon from "@lucide/svelte/icons/scroll-text";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import WrapTextIcon from "@lucide/svelte/icons/wrap-text";
import { untrack } from "svelte";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const build = $derived(data.build);
const subject = $derived(data.subject);
const active = $derived(isBuildActive(build.status));
const took = $derived(buildDurationMs(build));
const commits = $derived(Object.entries(build.commits));
const tools = $derived(toolchainEntries(build.toolchains));

// Named by what was built, as a check suite's page is: GitHub's and GitLab's name is the
// address's last part, the owner (or groups) said again in the line below; Radicle's address is
// shortened; a workspace's name is its own.
const title = $derived.by(() => {
  if (subject === null) {
    return build.subjectKind === "repo" ? "Removed repository" : "Removed workspace";
  }
  if (subject.provider === null) return subject.name;
  if (subject.provider === "github" || subject.provider === "gitlab") {
    return subject.name.split("/").at(-1) ?? subject.name;
  }
  return forgeRepoLabel({ provider: subject.provider, repoRef: subject.name });
});
const fullName = $derived(
  subject === null
    ? null
    : subject.provider === null
    ? subject.name
    : forgeRepoLabel({ provider: subject.provider, repoRef: subject.name }),
);

refreshWhileLive("app:build", () => isBuildActive(data.build.status));

// A clock for how long a running build has been going, on the poll's cadence. Read afresh when
// a build starts being watched: the page is kept when Rebuild opens the new build.
let now = $state(Date.now());
$effect(() => {
  if (!active) return;
  now = Date.now();
  const tick = setInterval(() => (now = Date.now()), 5_000);
  return () => clearInterval(tick);
});
const progress = $derived(buildProgress(build, now));

// A build that was replaced before a builder took it never ran, and has no log to read.
const neverRan = $derived(build.status === "superseded" && build.startedAt === null);

// The log, read when the page opens and again on every poll while the build is going. While it
// builds that is the latest lines only (the builder keeps the end of it); once it settled, the
// whole of it. Kept per build, so back and forward between two builds does not show one's log
// under the other.
type LogRead = { id: string; text: string } | { id: string; error: string } | {
  id: string;
  loading: true;
};
let log = $state<LogRead | null>(null);
const NO_OUTPUT = "This build left no output.";
// Reads overlap (the poll's, and the one a settle asks for): only the newest one asked may land,
// or a slow read of a running build's tail would write over the whole log after it settled.
let asked = 0;
// A poll's read waits for the one before it: a tail slower to read than the poll's cadence would
// otherwise have every answer overtaken, and nothing would ever land.
let polling = false;

async function readLog(id: string, quiet: boolean, poll = false) {
  if (poll) {
    if (polling) return;
    polling = true;
  }
  const mine = ++asked;
  if (!quiet) log = { id, loading: true };
  try {
    const text = await getEnvironmentLog(fetch, id);
    if (mine === asked && build.id === id) log = { id, text };
  } catch (e) {
    if (mine !== asked || build.id !== id) return;
    // A running build's missed read keeps what is on screen; the next poll asks again. A settled
    // one has no next poll, so its failure is said, with a retry, over the tail it showed.
    if (quiet && isBuildActive(build.status) && log !== null && "text" in log && log.id === id) {
      return;
    }
    log = {
      id,
      error: e instanceof ApiError && e.status === 404 ? NO_OUTPUT : "The log could not be read.",
    };
  } finally {
    if (poll) polling = false;
  }
}

// Primitives, so a poll's new build object re-runs the read only when the build or its status
// moved.
const buildId = $derived(data.build.id);
const status = $derived(data.build.status);
$effect(() => {
  const id = buildId;
  if (status === "queued" || neverRan) return;
  untrack(() => void readLog(id, log !== null && log.id === id));
  if (!isBuildActive(status)) return;
  const poll = setInterval(() => void readLog(id, true, true), 5_000);
  return () => clearInterval(poll);
});

const read = $derived(log !== null && log.id === build.id ? log : null);
const readError = $derived(read !== null && "error" in read ? read.error : null);
// A read that failed, as against a build with nothing to read: only that one is worth retrying.
const unreadable = $derived(readError !== null && readError !== NO_OUTPUT);
// Before the first read has landed (and on the server, which never reads it), the log is on its
// way rather than missing: the pane stays empty instead of saying there is none.
const reading = $derived(
  !neverRan && build.status !== "queued" && (read === null || "loading" in read),
);
// The log; the tail the build carries stands in only when the log could not be read.
const shownLog = $derived(
  read !== null && "text" in read && read.text.trim() !== ""
    ? read.text.trimEnd()
    : readError !== null
    ? build.logTail?.trimEnd() ?? null
    : null,
);

let wrap = $state(true);

// Find in the log, as on a check's page; another build starts it over.
const find = $derived.by(() => {
  void buildId;
  return new LogFind(() => shownLog);
});

// Rebuild builds the subject's default branch, whatever this build was of: it is the card's
// button, offered here too because a failed build is where a person reaches for it.
const mayRebuild = $derived(subject !== null && can(data.user, "resources:manage"));
let rebuilding = $state(false);
async function handleRebuild() {
  rebuilding = true;
  try {
    const next = await rebuildEnvironment(fetch, { kind: build.subjectKind, id: build.subjectId });
    toast.success("Rebuilding");
    await goto(`/builds/${next.id}`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to rebuild");
  } finally {
    rebuilding = false;
  }
}
</script>

<svelte:head>
  <title>{title} build · Ryph</title>
</svelte:head>

<!-- As a check suite's page: the full panel width, and on a wide screen exactly the viewport's
     height below the header, so the log scrolls inside its pane and nothing else moves. -->
<div
  class="-mx-(--bleed) flex flex-col gap-6 [--bleed:calc((100cqw_-_100%)_/_2)] lg:-mb-[calc(var(--page-gutter-y)_-_var(--page-gutter))] lg:h-[calc(100svh_-_2_*_var(--panel-cap)_-_--spacing(14)_-_var(--page-gutter-y)_-_var(--page-gutter)_-_1px)]"
>
  <PageTitle {title}>
    {#snippet aside()}
      <span class="text-muted-foreground font-mono text-xl tracking-tight">{build.ref}</span>
    {/snippet}
    {#snippet actions()}
      {#if mayRebuild}
        <Button variant="outline" size="sm" disabled={rebuilding} onclick={handleRebuild}>
          {#if rebuilding}
            <Spinner data-icon="inline-start" />
          {:else}
            <RotateCwIcon data-icon="inline-start" />
          {/if}
          Rebuild
        </Button>
      {/if}
    {/snippet}
    {#snippet description()}
      {buildKindLabel(build.kind)}
      {#if fullName !== null}
        for {fullName},
      {/if}
      {triggerLabel(build.trigger)}.
      {#if build.finishedAt}
        Finished {formatDateTime(build.finishedAt)}.
      {:else}
        Asked for {formatDateTime(build.createdAt)}.
      {/if}
    {/snippet}
  </PageTitle>

  <div
    class="grid items-start gap-6 lg:min-h-0 lg:flex-1 lg:grid-cols-[19rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
    <!-- What was built, and what came of it. -->
    <aside class="flex flex-col gap-5 lg:max-h-full lg:overflow-y-auto">
      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <BuildStatusBadge status={build.status} setupWarnings={build.setupWarnings} />
          {#if took !== null}
            <span class="text-muted-foreground text-sm tabular-nums">
              in {formatElapsed(took)}
            </span>
          {/if}
        </div>
        {#if progress !== null}
          <p class="text-muted-foreground text-sm tabular-nums">{progress}</p>
        {/if}
        {#if build.status === "superseded"}
          <p class="text-muted-foreground text-sm">
            {neverRan
            ? "A newer build took its place before it started."
            : "A newer build took over from this one."}
          </p>
        {/if}
      </div>

      <!-- A setup.yml that did not finish leaves a ready build missing what it skipped. -->
      <SetupWarnings warnings={build.setupWarnings} />
      <!-- However the build ended: a build refused a host usually still succeeds, and ships an
           image missing whatever it was for. -->
      {#if build.egressNote}
        <Alert.Root variant="destructive">
          <TriangleAlertIcon />
          <Alert.Title>The internet allowlist refused this build</Alert.Title>
          <Alert.Description>
            <Markdown content={build.egressNote} />
          </Alert.Description>
        </Alert.Root>
      {/if}

      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        <dt class="text-muted-foreground">Built for</dt>
        <dd class="min-w-0">
          {#if subject !== null}
            <a href={subject.href} class="break-all underline-offset-4 hover:underline">
              {fullName}
            </a>
          {:else}
            <span class="text-muted-foreground">
              {build.subjectKind === "repo" ? "A removed repository" : "A removed workspace"}
            </span>
          {/if}
        </dd>
        <dt class="text-muted-foreground">Branch</dt>
        <dd class="min-w-0 font-mono break-all">{build.ref}</dd>
        {#if build.reason}
          <dt class="text-muted-foreground">Why</dt>
          <dd class="min-w-0 break-words">{build.reason}</dd>
        {/if}
        <dt class="text-muted-foreground">{commits.length > 1 ? "Commits" : "Commit"}</dt>
        <dd class="min-w-0 font-mono">
          {#each commits as [path, sha] (path)}
            <span class="block truncate" title={sha}>
              {#if commits.length > 1}<span class="text-muted-foreground">{path}</span>{/if}
              {shortCommit(sha)}
            </span>
          {:else}
            <span class="text-muted-foreground">None</span>
          {/each}
        </dd>
        <dt class="text-muted-foreground">Machine</dt>
        <dd class="min-w-0">{machineLabel(build, build.subjectKind)}</dd>
        {#if build.baseDigest}
          <dt class="text-muted-foreground">Base image</dt>
          <dd class="min-w-0 truncate font-mono" title={build.baseDigest}>
            {shortImage(build.baseDigest)}
          </dd>
        {/if}
        {#if build.image}
          <dt class="text-muted-foreground">Image</dt>
          <dd class="flex min-w-0 items-center gap-1">
            <span class="truncate font-mono" title={build.image}>{shortImage(build.image)}</span>
            <CopyButton
              size="icon-sm"
              value={build.image}
              label="Copy the image reference"
              what="Image reference copied"
            />
          </dd>
        {/if}
        {#if build.sizeBytes !== null}
          <dt class="text-muted-foreground">Size</dt>
          <dd>{formatBytes(build.sizeBytes)}</dd>
        {/if}
        <dt class="text-muted-foreground">Asked</dt>
        <dd>{formatDateTime(build.createdAt)}</dd>
        {#if build.startedAt}
          <dt class="text-muted-foreground">Started</dt>
          <dd>{formatDateTime(build.startedAt)}</dd>
        {/if}
        {#if build.estimateMs !== null && build.status !== "superseded"}
          <dt class="text-muted-foreground">Usually</dt>
          <dd class="tabular-nums">{formatElapsed(build.estimateMs)}</dd>
        {/if}
      </dl>

      {#if tools.length > 0}
        <Separator />
        <div class="flex flex-col gap-2">
          <h2 class="text-muted-foreground text-xs">Toolchains</h2>
          <ul class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-xs">
            {#each tools as [name, version] (name)}
              <li class="contents">
                <span>{name}</span>
                <span class="text-muted-foreground truncate">{version}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </aside>

    <section
      aria-label="Build log"
      class="bg-card flex h-[75svh] min-h-96 flex-col overflow-hidden rounded-xl border lg:h-full"
    >
      <header class="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
        <h2 class="text-base font-medium">Log</h2>
        {#if active && shownLog !== null}
          <span class="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Spinner class="size-3" />
            Latest lines
          </span>
        {/if}
        <div class="ml-auto flex items-center gap-1">
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
          {#if build.status !== "queued" && !neverRan}
            <Button
              variant="ghost"
              size="sm"
              href={environmentLogHref(build.id)}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLinkIcon data-icon="inline-start" />
              Raw log
            </Button>
          {/if}
        </div>
        {#if unreadable && shownLog !== null}
          <p class="text-destructive basis-full text-xs">
            Showing the last lines only. {readError}
            <Button
              variant="link"
              size="sm"
              class="h-auto px-0 text-xs"
              onclick={() => readLog(build.id, false)}
            >
              Try again
            </Button>
          </p>
        {/if}
      </header>

      <!-- A build's output is the repository's own text: it is only ever rendered as text. -->
      {#if shownLog !== null}
        {#key build.id}
          <LogView text={shownLog} {wrap} line={find.line} class="flex-1" />
        {/key}
      {:else if reading}
        <!-- Usually here in a moment: an empty pane, rather than a state that only flashes. -->
        <div class="flex-1"></div>
      {:else}
        <Empty.Root class="flex-1 border-0">
          <Empty.Header>
            <Empty.Media variant="icon">
              {#if active}
                <Spinner />
              {:else}
                <ScrollTextIcon />
              {/if}
            </Empty.Media>
            <Empty.Title>
              {#if build.status === "queued"}
                Not started yet
              {:else if neverRan}
                Never ran
              {:else if build.status === "building"}
                Building
              {:else}
                No log
              {/if}
            </Empty.Title>
            <Empty.Description>
              {#if build.status === "queued"}
                The log shows here once a builder picks this build up.
              {:else if neverRan}
                A newer build took its place before it started.
              {:else if build.status === "building"}
                Nothing logged yet. The log shows here as the build goes.
              {:else if readError !== null}
                {readError}
              {:else}
                This build left no output.
              {/if}
            </Empty.Description>
          </Empty.Header>
          {#if unreadable && !active}
            <Empty.Content>
              <Button variant="outline" size="sm" onclick={() => readLog(build.id, false)}>
                Try again
              </Button>
            </Empty.Content>
          {/if}
        </Empty.Root>
      {/if}
    </section>
  </div>
</div>
