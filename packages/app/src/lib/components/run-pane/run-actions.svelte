<script lang="ts">
import type {
  CheckSuiteView,
  ForgeToolAction,
  Patch,
  PatchBuild,
  RunArtifact,
  ThreadKind,
} from "$lib/api/types";
import ArtifactThumbnail from "$lib/components/artifact-thumbnail/artifact-thumbnail.svelte";
import CheckSuiteChecks from "$lib/components/check-suite-panel/check-suite-checks.svelte";
import CheckStateBadge from "$lib/components/check-state-badge/check-state-badge.svelte";
import MemoryNote from "./memory-note.svelte";
import PatchItem from "./patch-item.svelte";
import PaneCard from "./pane-card.svelte";
import Markdown from "$lib/components/markdown/markdown.svelte";
import type { ForgeWrite } from "$lib/utils/forge-calls";
import { Badge } from "$lib/components/ui/badge";
import { TONES } from "$lib/components/ui/badge/tones";
import { Button } from "$lib/components/ui/button";
import * as Empty from "$lib/components/ui/empty";
import * as ToggleGroup from "$lib/components/ui/toggle-group";
import { environmentLogHref } from "$lib/api/environments";
import { countsLabel, listedSuiteIds, suiteCounts } from "$lib/utils/checks";
import { SvelteSet } from "svelte/reactivity";
import { untrack } from "svelte";
import { VList } from "virtua/svelte";
import {
  environmentStatusLabel,
  formatBytes,
  isReadyWithSetupWarnings,
  patchBuildLabel,
  setupWarningLabel,
  shortCommit,
} from "$lib/utils/environments";
import { latestRunVersion, runArtifactLabel } from "$lib/utils/artifacts";
import { repoThreadLabel } from "$lib/utils/forge";
import { formatDateTime, formatElapsed, formatTime } from "$lib/utils/format";
import type { MemoryCall } from "$lib/utils/memory-calls";
import AppWindowIcon from "@lucide/svelte/icons/app-window";
import BoxIcon from "@lucide/svelte/icons/box";
import BrainIcon from "@lucide/svelte/icons/brain";
import CircleCheckBigIcon from "@lucide/svelte/icons/circle-check-big";
import CircleDotIcon from "@lucide/svelte/icons/circle-dot";
import CircleXIcon from "@lucide/svelte/icons/circle-x";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import FileSearchIcon from "@lucide/svelte/icons/file-search";
import GitPullRequestIcon from "@lucide/svelte/icons/git-pull-request";
import ListChecksIcon from "@lucide/svelte/icons/list-checks";
import MessageSquareIcon from "@lucide/svelte/icons/message-square";
import PackageIcon from "@lucide/svelte/icons/package";
import TagIcon from "@lucide/svelte/icons/tag";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";

let {
  patches,
  suites,
  allSuites,
  forgeActions,
  builds,
  memoryCalls,
  forgeWrites,
  toldPatches,
  target,
  terminal,
  artifacts = [],
  runId = null,
  onopenartifact,
  focusArtifact = null,
  onfocusedartifact,
}: {
  /** The patches the run opened. */
  patches: Patch[];
  /** The check suites the run asked for, and the ones on its patches' heads. */
  suites: CheckSuiteView[];
  /** Every suite the task has, which is where a patch's verdict is looked up. */
  allSuites: CheckSuiteView[];
  /** What the run wrote on the forge. */
  forgeActions: ForgeToolAction[];
  /** The environment builds its patches asked for. */
  builds: PatchBuild[];
  /** What it proposed, confirmed and refuted in memory, read off its calls. */
  memoryCalls: MemoryCall[];
  /** What each forge write said, by its ledger id; one whose call is not loaded is missing. */
  forgeWrites: Map<string, ForgeWrite>;
  /** The patches whose build result was posted to the run. */
  toldPatches: Set<string>;
  /** The change request the task works on, which its patches in that repo push to. */
  target: { connectedRepoId: string; thread: string } | null;
  terminal: boolean;
  /** The artifacts the run published or put a new version on. */
  artifacts?: RunArtifact[];
  /** The run these actions are of, which tells a published artifact from an updated one. */
  runId?: string | null;
  /** Opens an artifact in the pane, in place of this list. */
  onopenartifact?: (id: string) => void;
  /** The artifact the pane just came back from: its row is brought into view and focused. */
  focusArtifact?: string | null;
  /** The row of `focusArtifact` has focus, so it need not be focused again. */
  onfocusedartifact?: () => void;
} = $props();

type Kind = "patch" | "checks" | "forge" | "build" | "memory" | "artifact";

type Item =
  | { kind: "patch"; key: string; at: string; patch: Patch; earlier: Patch[] }
  | { kind: "checks"; key: string; at: string; suite: CheckSuiteView }
  | { kind: "forge"; key: string; at: string; action: ForgeToolAction }
  | { kind: "build"; key: string; at: string; build: PatchBuild }
  | { kind: "memory"; key: string; at: string; call: MemoryCall }
  | { kind: "artifact"; key: string; at: string; artifact: RunArtifact; version: number };

// A patch replaced before it reached the forge (the agent submitted again while it still waited
// for approval or its turn) is folded under the version that replaced it. One that reached the
// forge stays an item of its own: the next one is a further push, not a new version of it. A
// replacement this run does not hold leaves the old version standing alone.
const latestPatches = $derived.by(() => {
  const byId = new Map(patches.map((patch) => [patch.id, patch]));
  const replaced = new Map<string, Patch>();
  for (const patch of patches) {
    if (patch.supersededByPatchId !== null && byId.has(patch.supersededByPatchId)) {
      replaced.set(patch.supersededByPatchId, patch);
    }
  }
  return patches
    .filter((patch) => patch.supersededByPatchId === null || !byId.has(patch.supersededByPatchId))
    .map((patch) => {
      const earlier: Patch[] = [];
      const seen = new Set([patch.id]);
      for (
        let prev = replaced.get(patch.id);
        prev && !seen.has(prev.id);
        prev = replaced.get(prev.id)
      ) {
        seen.add(prev.id);
        earlier.push(prev);
      }
      return { patch, earlier };
    });
});

// What a patch or a build looks up, kept by id: a lookup per row through the whole list was
// quadratic in a long run's patches and suites.
const suiteById = $derived(
  new Map(allSuites.filter((suite) => !suite.partial).map((suite) => [suite.id, suite])),
);
const patchById = $derived(new Map(patches.map((patch) => [patch.id, patch])));

// The change request each patch reached: the task's own, or the one an earlier patch of the run
// opened. Only the first patch there opened it; every later one pushed to it.
// A thread number is only a change request together with its repo.
const crKey = (repo: string, thread: string) => `${repo}:${thread}`;
const openedBy = $derived.by(() => {
  const first = new Map<string, Patch>();
  for (
    const patch of patches.toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  ) {
    if (patch.forgeRef === null) continue;
    const key = crKey(patch.connectedRepoId, patch.forgeRef);
    if (!first.has(key)) first.set(key, patch);
  }
  return first;
});
// The repos this run shipped more than one line of work in: there each patch names its line.
const multiLine = $derived.by(() => {
  const lines = new Map<string, Set<string>>();
  for (const patch of patches) {
    const key = `${patch.connectedRepoId}:${patch.path}`;
    lines.set(key, (lines.get(key) ?? new Set()).add(patch.line));
  }
  return new Set([...lines].filter(([, seen]) => seen.size > 1).map(([key]) => key));
});

const pushedOnly = (patch: Patch) =>
  patch.forgeRef !== null &&
  ((target !== null && target.connectedRepoId === patch.connectedRepoId &&
    target.thread === patch.forgeRef) ||
    openedBy.get(crKey(patch.connectedRepoId, patch.forgeRef))?.id !== patch.id);

// A suite's checks are listed on the newest full suite of each line of work, and on any that did
// not pass or is still going; an older passed one shows its verdict alone, its checks a click away.
// Opened ones are kept here rather than in the row, which the list unmounts as it scrolls out of
// view.
const listedSuites = $derived(listedSuiteIds(suites, patches));
const openedSuites = new SvelteSet<string>();

// Everything the run made, newest first: on a live run what just happened is at the top, and on
// a finished one the top is what it came to.
const items = $derived(
  [
    ...latestPatches.map(({ patch, earlier }): Item => ({
      kind: "patch",
      key: `patch:${patch.id}`,
      at: patch.createdAt,
      patch,
      earlier,
    })),
    ...suites.map((suite): Item => ({
      kind: "checks",
      key: `checks:${suite.id}`,
      at: suite.createdAt,
      suite,
    })),
    ...forgeActions.map((action): Item => ({
      kind: "forge",
      key: `forge:${action.id}`,
      at: action.createdAt,
      action,
    })),
    ...builds.map((build): Item => ({
      kind: "build",
      key: `build:${build.patchId}`,
      at: build.checkedAt,
      build,
    })),
    ...memoryCalls.map((call): Item => ({
      kind: "memory",
      key: `memory:${call.seq}`,
      at: call.at,
      call,
    })),
    // Each artifact as this run left it: its newest version from this run, and when that was.
    ...artifacts.flatMap((artifact): Item[] => {
      const made = latestRunVersion(artifact, runId);
      return made === null ? [] : [{
        kind: "artifact",
        key: `artifact:${artifact.id}`,
        at: made.createdAt,
        artifact,
        version: made.version,
      }];
    }),
  ].map((item) => ({ item, t: Date.parse(item.at) }))
    .toSorted((a, b) => b.t - a.t)
    .map(({ item }) => item),
);

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "patch", label: "Patches" },
  { kind: "checks", label: "Checks" },
  { kind: "forge", label: "Forge" },
  { kind: "build", label: "Builds" },
  { kind: "memory", label: "Memory" },
  { kind: "artifact", label: "Artifacts" },
];

const counts = $derived(
  new Map(KINDS.map(({ kind }) => [kind, items.filter((item) => item.kind === kind).length])),
);
// Only the kinds this run has anything of: a filter that empties the list teaches nothing.
const filters = $derived(KINDS.filter(({ kind }) => (counts.get(kind) ?? 0) > 0));

let filter = $state<Kind | "all">("all");
// A kind the run no longer has (another task, the same component) falls back to everything.
const active = $derived(filters.some(({ kind }) => kind === filter) ? filter : "all");
const shown = $derived(active === "all" ? items : items.filter((item) => item.kind === active));

function forgeIcon(action: ForgeToolAction) {
  switch (action.tool) {
    case "create_issue":
      return CircleDotIcon;
    case "add_comment":
      return MessageSquareIcon;
    case "add_labels":
      return TagIcon;
    case "submit_review":
      return FileSearchIcon;
    case "close_issue":
      return CircleXIcon;
  }
}

/** The kind of thread a ledger row's tool writes to, where the tool alone says. */
function threadKindOf(tool: ForgeToolAction["tool"]): ThreadKind | null {
  switch (tool) {
    case "create_issue":
    case "close_issue":
      return "issue";
    case "submit_review":
      return "change_request";
    default:
      return null;
  }
}

/** One ledger row in words: what was written, and where, each forge spelling its own thread. */
function forgeLabel(action: ForgeToolAction): string {
  const repo = { provider: action.provider, repoRef: action.repoRef };
  const thread = action.threadRef === null
    ? `${action.repoRef} (thread unknown)`
    : repoThreadLabel(repo, threadKindOf(action.tool), action.threadRef);
  switch (action.tool) {
    case "create_issue":
      return action.createdThreadRef === null
        ? `Opening an issue on ${action.repoRef}`
        : `Opened ${repoThreadLabel(repo, "issue", action.createdThreadRef)}`;
    case "add_comment":
      return `Commented on ${thread}`;
    case "add_labels":
      return `Labelled ${thread}`;
    case "submit_review":
      return `Reviewed ${thread}`;
    case "close_issue":
      return `Closed ${thread}`;
  }
}

let list = $state<ReturnType<typeof VList> | null>(null);
let box = $state<HTMLElement | null>(null);

// Back from an artifact: its row comes into view and takes focus, once, when the list is there.
$effect(() => {
  const id = untrack(() => focusArtifact);
  if (id === null || list === null || box === null) return;
  const index = untrack(() => shown).findIndex((item) => item.key === `artifact:${id}`);
  if (index === -1) return;
  list.scrollToIndex(index, { align: "nearest" });
  const scope = box;
  let tries = 0;
  let frame = requestAnimationFrame(function focus() {
    const row = scope.querySelector<HTMLElement>(`[data-artifact-row="${CSS.escape(id)}"]`);
    if (row !== null) {
      row.focus({ preventScroll: true });
      onfocusedartifact?.();
    } else if (++tries < 10) frame = requestAnimationFrame(focus);
  });
  return () => cancelAnimationFrame(frame);
});

/** The `after:` overlay that makes a row's title link cover the whole row. */
const rowLink =
  "outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring";
</script>

{#if items.length === 0}
  <Empty.Root class="flex-1">
  <Empty.Header>
    <Empty.Media variant="icon">
      <BoxIcon />
    </Empty.Media>
    <Empty.Title>{terminal ? "No actions" : "No actions yet"}</Empty.Title>
    <Empty.Description>
        Patches, checks, builds, artifacts, memories and what the agent writes on the forge show
        up here.
      </Empty.Description>
  </Empty.Header>
</Empty.Root>
{:else}
  <div bind:this={box} class="flex min-h-0 flex-1 flex-col">
    {#if filters.length > 1}
      <div class="shrink-0 overflow-x-auto px-4 pt-4 pb-3 [scrollbar-width:none]">
        <ToggleGroup.Root
          type="single"
          size="sm"
          variant="outline"
          aria-label="Filter actions"
          bind:value={() => active, (v) => (filter = (v || "all") as Kind | "all")}
        >
          <ToggleGroup.Item value="all">All</ToggleGroup.Item>
          {#each filters as { kind, label } (kind)}
            <ToggleGroup.Item value={kind}>
              {label}
              <span class="text-muted-foreground tabular-nums">{counts.get(kind)}</span>
            </ToggleGroup.Item>
          {/each}
        </ToggleGroup.Root>
      </div>
    {/if}

    <!-- A timeline: one rail down the left, each item a node on it. The rail stops at the first
         and last node rather than running past them, so the list reads as having two ends.
         Virtualised, since a long run makes hundreds of things: only the items near the viewport
         are mounted, measured as they render, so an item that opens up moves the rest down. The
         list's own ends are drawn by its first and last items, which the virtualiser positions
         absolutely, so neither CSS's first-child nor the scroller's padding can. -->
    <!-- Keyed on the filter, since a filtered list is a different list. No `shift`: items arrive
         anywhere in it (a memory or a forge write lands at its own time as the transcript loads),
         and `shift` takes every change for one at the top. -->
    {#key active}
        <VList
      bind:this={list}
      data={shown}
      getKey={(item) => item.key}
      class="scroll-fade-y min-h-0 flex-1 overscroll-contain"
    >
      {#snippet children(item, index)}
        {@const first = index === 0}
        {@const last = index === shown.length - 1}
        <div class={["px-2", first && "pt-2", last && "pb-4"]}>
          <div
            class={[
              "relative grid grid-cols-[2.25rem_minmax(0,1fr)]",
              // The rail, for a list of more than one; a lone item has none. Any `before:` class
              // brings the pseudo-element into being, so none is set on a lone item at all: one
              // that was not absolutely placed took the grid's first cell and pushed the node and
              // the body a column over.
              !(first && last) && [
                "before:bg-border before:absolute before:top-0 before:bottom-0 before:left-[1.125rem] before:w-px before:-translate-x-1/2",
                first && "before:top-[1.375rem]",
                last && "before:bottom-[calc(100%_-_1.375rem)]",
              ],
            ]}
          >
            {@render node(item)}
            <div
              class="hover:bg-sidebar-accent/60 relative isolate flex min-w-0 flex-col gap-1.5 rounded-lg px-2 py-2.5 text-sm transition-colors"
            >
              {@render body(item)}
            </div>
          </div>
        </div>
      {/snippet}
    </VList>
    {/key}
  </div>
{/if}

{#snippet node(item: Item)}
  {@const Icon = item.kind === "patch"
    ? GitPullRequestIcon
    : item.kind === "checks"
    ? CircleCheckBigIcon
    : item.kind === "forge"
    ? forgeIcon(item.action)
    : item.kind === "memory"
    ? BrainIcon
    : item.kind === "artifact"
    ? AppWindowIcon
    : PackageIcon}
  <div class="relative flex justify-center pt-2.5">
  <span
    class="bg-sidebar text-muted-foreground flex size-6 items-center justify-center rounded-full border"
  >
    <Icon class="size-3.5" />
  </span>
</div>
{/snippet}

{#snippet when(at: string)}
  <time datetime={at} title={formatDateTime(at)}
  class="text-muted-foreground relative z-10 shrink-0 text-xs tabular-nums">
    {formatTime(at)}
  </time>
{/snippet}

{#snippet body(item: Item)}
  {#if item.kind === "patch"}
    <PatchItem
  patch={item.patch}
  earlier={item.earlier}
  pushed={pushedOnly(item.patch)}
  showLine={multiLine.has(`${item.patch.connectedRepoId}:${item.patch.path}`)}
  suite={item.patch.checksSuiteId === null ? null : (suiteById.get(item.patch.checksSuiteId) ?? null)}
  {terminal}
/>
  {:else if item.kind === "checks"}
    {@const suite = item.suite}
    <div class="flex items-baseline gap-2">
      <a href="/checks/{suite.id}" class={["min-w-0 flex-1 font-medium", rowLink]}>
        Checks on {suite.repoRef ?? suite.connectedRepoId}
      </a>
      {@render when(item.at)}
    </div>
    <div class="text-muted-foreground relative z-10 truncate font-mono text-xs"
  title={suite.commit}>
      at {shortCommit(suite.commit)}
    </div>
    <!-- The verdict and the checks behind it, each opening its log. -->
    {@const listed = listedSuites.has(suite.id) || openedSuites.has(suite.id)}
    <PaneCard clip={false}>
      <div class="flex flex-wrap items-center gap-1.5">
        <CheckStateBadge state={suite.state} />
        <span class="text-muted-foreground text-xs">{countsLabel(suiteCounts(suite))}</span>
        {#if !listedSuites.has(suite.id)}
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground ml-auto text-xs underline-offset-4 hover:underline"
            aria-expanded={listed}
            onclick={() =>
              listed ? openedSuites.delete(suite.id) : openedSuites.add(suite.id)}
          >
            {listed ? "Hide checks" : "Show checks"}
          </button>
        {/if}
      </div>
      {#if listed}
        <CheckSuiteChecks {suite} />
      {/if}
    </PaneCard>
    <div class="relative z-10 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
      {#if suite.generation > 1}
        <Badge variant="outline" title="Times this suite has run">#{suite.generation}</Badge>
      {/if}
      <Button href="/checks/{suite.id}" variant="outline" size="xs" class="ml-auto">
        <ListChecksIcon data-icon="inline-start" />
        Open checks
      </Button>
    </div>
  {:else if item.kind === "forge"}
    {@const action = item.action}
    <div class="flex items-baseline gap-2">
      {#if action.url}
        <a
          href={action.url}
          target="_blank"
          rel="noreferrer"
          class={["min-w-0 flex-1 font-medium", rowLink]}
        >
          {forgeLabel(action)}
          <ExternalLinkIcon class="text-muted-foreground ml-0.5 inline size-3 align-baseline" />
        </a>
      {:else}
        <span class="min-w-0 flex-1 font-medium">{forgeLabel(action)}</span>
      {/if}
      {@render when(item.at)}
    </div>
    {@const write = forgeWrites.get(action.id)}
    {#if write}
      {@render forgeWords(write)}
    {/if}
    <!-- A review or comment opens where it was posted. -->
    {@const view = action.url === null
      ? null
      : action.tool === "submit_review"
      ? "View review"
      : action.tool === "add_comment"
      ? "View comment"
      : null}
    {#if action.state !== "done" || view !== null}
      <div class="relative z-10 flex flex-wrap items-center gap-1.5">
        {#if action.state === "failed"}
          <Badge variant="destructive">Failed</Badge>
          {#if action.detail}
            <span class="text-muted-foreground text-xs">{action.detail}</span>
          {/if}
        {:else if action.state === "reserved"}
          <!-- Reserved and never completed: the write may or may not have landed. Once the run
               is over nobody is still waiting to learn which. -->
          <Badge variant="outline">{terminal ? "Outcome unknown" : "Pending"}</Badge>
        {/if}
        {#if view !== null && action.url !== null}
          <Button
            href={action.url}
            target="_blank"
            rel="noreferrer"
            variant="outline"
            size="xs"
            class="ml-auto"
          >
            {view}
            <ExternalLinkIcon data-icon="inline-end" />
          </Button>
        {/if}
      </div>
    {/if}
  {:else if item.kind === "memory"}
    {@render memory(item.call)}
  {:else if item.kind === "artifact"}
    {@render artifactItem(item.artifact, item.version, item.at)}
  {:else}
    {@const build = item.build}
    {@const env = build.environment}
    {@const patch = patchById.get(build.patchId)}
    {@const warned = env !== null && isReadyWithSetupWarnings(env)}
    <div class="flex items-baseline gap-2">
      {#if env}
        <a
          href={environmentLogHref(env.id)}
          target="_blank"
          rel="noreferrer"
          class={["min-w-0 flex-1 font-medium", rowLink]}
          title="Open the build log"
        >
          Environment build
        </a>
      {:else}
        <span class="min-w-0 flex-1 font-medium">Environment build</span>
      {/if}
      {@render when(item.at)}
    </div>
    <div class="text-muted-foreground truncate font-mono text-xs">
      {patch?.path ?? build.patchId}/ at {patch ? shortCommit(patch.headSha) : "—"}
    </div>
    <div class="flex flex-wrap items-center gap-1.5">
      <!-- Ready with setup warnings is still ready, but said in amber: the image lacks what the
           skipped setup steps would have done. -->
      <Badge
        variant={warned
          ? "default"
          : env?.status === "failed"
          ? "destructive"
          : env?.status === "ready"
          ? "secondary"
          : "outline"}
        class={warned ? TONES.warning : undefined}
      >
        {#if warned}
          <TriangleAlertIcon />
          {setupWarningLabel(env?.setupWarnings)}
        {:else}
          {env !== null
            ? environmentStatusLabel(env.status)
            : build.note === null
            ? "Checking"
            : "No build"}
        {/if}
      </Badge>
      {#if env?.status === "ready"}
        {#if env.sizeBytes !== null}
          <span class="text-muted-foreground text-xs">{formatBytes(env.sizeBytes)}</span>
        {/if}
        {#if env.startedAt && env.finishedAt}
          <span class="text-muted-foreground text-xs">
            built in {formatElapsed(Date.parse(env.finishedAt) - Date.parse(env.startedAt))}
          </span>
        {/if}
      {/if}
      {#if toldPatches.has(build.patchId)}
        <span class="text-muted-foreground text-xs">told to the run</span>
      {:else if build.reportedAt && env && terminal}
        <span class="text-muted-foreground text-xs">not posted to the run</span>
      {/if}
    </div>
    {#if env === null}
      <p class="text-muted-foreground text-xs">{patchBuildLabel(build)}.</p>
    {/if}
  {/if}
{/snippet}

<!-- A page the run published or updated: its thumbnail, title and version. The whole row opens it
     in the pane; the thumbnail lets clicks through to the row. -->
{#snippet artifactItem(artifact: RunArtifact, version: number, at: string)}
  <div class="flex items-baseline gap-2">
    <button
      type="button"
      data-artifact-row={artifact.id}
      class={["min-w-0 flex-1 text-left font-medium", rowLink]}
      onclick={() => onopenartifact?.(artifact.id)}
    >
      {runArtifactLabel(artifact, runId)}
    </button>
    {@render when(at)}
  </div>
  <div
  class="bg-background pointer-events-none my-0.5 flex flex-col overflow-hidden rounded-md border">
  <ArtifactThumbnail
    id={artifact.id}
    {version}
    title="Preview of {artifact.title}"
    class="aspect-[16/10] w-full border-b"
  />
  <div class="flex min-w-0 flex-col gap-0.5 px-3 py-2">
    <span class="truncate font-medium">{artifact.title}</span>
    <span
      class="text-muted-foreground text-xs tabular-nums">Version {version}</span>
  </div>
</div>
{/snippet}

{#snippet memory(call: MemoryCall)}
  {@const label = call.tool === "propose"
    ? "Proposed a memory"
    : call.tool === "confirm"
    ? "Confirmed a memory"
    : "Refuted a memory"}
  {@const id = call.tool === "propose" ? call.proposalId : call.id}
  <!-- A confirmed or refuted memory opens on its own page. A proposal is not a memory yet: it
       waits in the memory inbox until someone accepts it. -->
  {@const href = id === null
    ? null
    : call.tool === "propose"
    ? `/memory?tab=inbox#proposal-${id}`
    : `/memory/${id}`}
  <div class="flex items-baseline gap-2">
    {#if href !== null}
      <a {href} class={["min-w-0 flex-1 font-medium", rowLink]}>{label}</a>
    {:else}
      <span class="min-w-0 flex-1 font-medium">{label}</span>
    {/if}
    {@render when(call.at)}
  </div>
  {#if call.tool === "refute" && call.reason !== null}
    <p
  class="text-muted-foreground relative z-10 line-clamp-3 text-xs text-pretty">{call.reason}</p>
  {/if}
  {#if call.tool === "propose" && call.text !== null}
    <MemoryNote text={call.text} />
  {:else if call.tool === "refute" && call.replacement !== null}
    <MemoryNote text={call.replacement} />
  {/if}
  {#if call.state === "pending" || id !== null}
    <div class="flex flex-wrap items-center gap-1.5">
      {#if call.state === "pending"}
        <Badge variant="outline">{terminal ? "Outcome unknown" : "Pending"}</Badge>
      {/if}
      {#if id !== null}
        <span class="text-muted-foreground relative z-10 font-mono text-xs select-all">{id}</span>
      {/if}
    </div>
  {/if}
{/snippet}

<!-- What a forge write said: the comment, the review and its remarks, the issue it opened, the
     labels it put on. -->
{#snippet forgeWords(write: ForgeWrite)}
  {#if write.tool === "add_labels"}
    {#if write.labels.length > 0}
      <div class="flex flex-wrap gap-1">
        {#each write.labels as label (label)}
          <Badge variant="secondary">{label}</Badge>
        {/each}
      </div>
    {/if}
  {:else if write.tool === "close_issue"}
    <div class="flex flex-wrap gap-1">
  <Badge variant="outline">{write.reason === "not_planned" ? "Not planned" : "Completed"}</Badge>
</div>
    {#if write.comment !== null}
      <PaneCard>
  <Markdown compact content={write.comment} />
</PaneCard>
    {/if}
  {:else if write.tool === "add_comment"}
    {#if write.reply}
      <div class="flex flex-wrap gap-1">
        <Badge variant="outline">Review reply</Badge>
        {#if write.resolve}
          <Badge variant="secondary">Requested thread resolution</Badge>
        {/if}
      </div>
    {/if}
    {#if write.body !== null}
      <PaneCard>
  <Markdown compact content={write.body} />
</PaneCard>
    {/if}
  {:else if write.tool === "create_issue"}
    {#if write.title !== null || write.body !== null}
      <PaneCard>
        {#if write.title !== null}
          <p class="font-medium">{write.title}</p>
        {/if}
        {#if write.body !== null}
          <Markdown compact content={write.body} />
        {/if}
      </PaneCard>
    {/if}
    {#if write.labels.length > 0}
      <div class="flex flex-wrap gap-1">
        {#each write.labels as label (label)}
          <Badge variant="secondary">{label}</Badge>
        {/each}
      </div>
    {/if}
  {:else}
    <PaneCard>
      {#if write.body !== null}
        <Markdown compact content={write.body} />
      {/if}
      {#if write.remarks.length > 0}
        <ul class={["flex flex-col gap-2", write.body !== null && "border-t pt-2"]}>
          {#each write.remarks as remark, i (i)}
            <li class="flex flex-col gap-0.5">
              <span class="text-muted-foreground truncate font-mono text-xs" title={remark.path}>
                {remark.path}:{remark.line}
              </span>
              <Markdown compact content={remark.body} />
            </li>
          {/each}
        </ul>
      {/if}
    </PaneCard>
    {#if write.remarks.length > 0}
      <span class="text-muted-foreground text-xs">
        {write.remarks.length} {write.remarks.length === 1 ? "remark" : "remarks"} on the diff
      </span>
    {/if}
  {/if}
{/snippet}
