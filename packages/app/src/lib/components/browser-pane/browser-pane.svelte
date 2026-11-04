<script lang="ts">
import type { LiveSource } from "$lib/api/browser-live";
import { Button } from "$lib/components/ui/button";
import * as Empty from "$lib/components/ui/empty";
import { Input } from "$lib/components/ui/input";
import * as Tabs from "$lib/components/ui/tabs";
import * as ToggleGroup from "$lib/components/ui/toggle-group";
import { browserToolIcon } from "$lib/components/tool-call/browser-icons";
import { formatTime } from "$lib/utils/format";
import GlobeIcon from "@lucide/svelte/icons/globe";
import MonitorIcon from "@lucide/svelte/icons/monitor";
import XIcon from "@lucide/svelte/icons/x";
import { untrack } from "svelte";
import { BrowserLiveState } from "./browser-live-state.svelte";
import BrowserViewport from "./browser-viewport.svelte";
import { followTail } from "./follow-tail.svelte";
import LiveChip from "./live-chip.svelte";
import {
  type ActionItem,
  activeTab,
  chipFor,
  type ConsoleFilter,
  filterConsole,
  isFailedRequest,
  mergeActions,
  shortUrl,
  type TranscriptAction,
} from "./live-view";

let {
  source,
  runEnded,
  calls,
  onselect,
  onclose,
  header = true,
}: {
  /** Where the live state comes from. Opened when the pane mounts and closed when it goes. */
  source: LiveSource;
  /** The run is over, as the page knows it. */
  runEnded: boolean;
  /** The transcript's browser calls, which the Actions tab lists alongside the live ones. */
  calls: TranscriptAction[];
  /** An action was picked; the page shows it in the transcript. */
  onselect?: (seq: number) => void;
  /** Absent where the container brings its own close button (the sheet). */
  onclose?: () => void;
  /**
   * Its own title bar. Off where the container already names it, as a tab does: the stream's
   * state then rides beside the address instead.
   */
  header?: boolean;
} = $props();

// A new source is a different browser: a new state, and its stream opened in its place.
const live = $derived(new BrowserLiveState(source));
$effect(() => {
  const state = live;
  return untrack(() => state.connect());
});

const chip = $derived(chipFor(live, runEnded));
const tab = $derived(activeTab(live.tabs));

let height = $state(0);

let panel = $state("actions");

const actions = $derived(mergeActions(calls, live.actions));

let level = $state<ConsoleFilter>("all");
let query = $state("");
const consoleLines = $derived(filterConsole(live.console, level, query));
const errorCount = $derived(live.console.filter((line) => line.level === "error").length);
const failedCount = $derived(live.network.filter(isFailedRequest).length);

const clock = (at: number) => formatTime(new Date(at).toISOString());
</script>

<section bind:clientHeight={height} class="flex h-full min-h-0 flex-col" aria-label="Browser">
  {#if header}
  <header class="flex h-12 shrink-0 items-center gap-2 px-4">
    <MonitorIcon class="text-muted-foreground size-4" />
    <h2 class="text-sm font-medium">Browser</h2>
    <LiveChip {chip} retrying={live.connection === "retrying"} />
    {#if onclose}
      <Button variant="ghost" size="icon-sm" class="ml-auto" onclick={onclose}>
        <XIcon />
        <span class="sr-only">Close the browser</span>
      </Button>
    {/if}
  </header>
  {/if}

  <!-- Without its own title bar it sits under its container's tab strip, and takes the same space
       from it the other tabs' content does. -->
  <div class={["flex shrink-0 flex-col gap-2 px-4 pb-3", !header && "pt-4"]}>
    {#if live.tabs.length > 1}
      <!-- Which tabs the agent has open, the one on screen marked. -->
      <ul class="flex gap-1 overflow-x-auto [scrollbar-width:none]" aria-label="Open tabs">
        {#each live.tabs as t (t.id)}
          <li
            aria-current={t.id === tab?.id ? "true" : undefined}
            title={t.url}
            class={[
              "max-w-40 shrink-0 truncate rounded-md border px-2 py-0.5 text-xs",
              t.id === tab?.id
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground border-transparent",
            ]}
          >
            {t.title || t.url}
          </li>
        {/each}
      </ul>
    {/if}

    <div class="flex min-w-0 items-center gap-2">
      <div
        class="bg-muted text-muted-foreground flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full px-3 text-xs"
        title={tab?.url}
      >
        <GlobeIcon class="size-3.5 shrink-0" />
        <span class={["truncate font-mono", tab !== null && "text-foreground"]}>
          {tab?.url ?? "No page open"}
        </span>
      </div>
      {#if !header}
        <LiveChip {chip} retrying={live.connection === "retrying"} />
      {/if}
    </div>

    <BrowserViewport
      frame={live.frame}
      highlight={live.highlight}
      {chip}
      maxHeight={Math.max(160, height * 0.5)}
    />
  </div>

  <Tabs.Root bind:value={panel} class="flex min-h-0 flex-1 flex-col gap-0 border-t">
    <Tabs.List variant="line" class="shrink-0 px-3 pt-1">
      <Tabs.Trigger value="actions">Actions</Tabs.Trigger>
      <Tabs.Trigger value="console">
        Console
        {#if errorCount > 0}
          <span class="text-destructive tabular-nums">{errorCount}</span>
        {/if}
      </Tabs.Trigger>
      <Tabs.Trigger value="network">
        Network
        {#if failedCount > 0}
          <span class="text-destructive tabular-nums">{failedCount}</span>
        {/if}
      </Tabs.Trigger>
    </Tabs.List>

    <Tabs.Content value="actions" class="flex min-h-0 flex-1 flex-col">
      {#if actions.length === 0}
        {@render nothing("No actions yet")}
      {:else}
        <ol
          {@attach followTail(() => actions.length)}
          class="scroll-fade-y min-h-0 flex-1 overflow-y-auto overscroll-contain py-2"
        >
          {#each actions as item (item.key)}
            <li>
              {#if item.seq === null}
                <div class="flex w-full items-center gap-2.5 px-4 py-1.5 text-sm">
                  {@render actionRow(item)}
                </div>
              {:else}
                {@const seq = item.seq}
                <button
                  type="button"
                  onclick={() => onselect?.(seq)}
                  title="Show in the transcript"
                  class="hover:bg-muted/60 focus-visible:bg-muted/60 flex w-full cursor-pointer items-center gap-2.5 px-4 py-1.5 text-left text-sm outline-none"
                >
                  {@render actionRow(item)}
                </button>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}
    </Tabs.Content>

    <Tabs.Content value="console" class="flex min-h-0 flex-1 flex-col">
      <div class="flex shrink-0 items-center gap-2 px-4 py-2">
        <ToggleGroup.Root
          type="single"
          size="sm"
          variant="outline"
          bind:value={() => level, (v) => (level = (v || "all") as ConsoleFilter)}
        >
          <ToggleGroup.Item value="all">All</ToggleGroup.Item>
          <ToggleGroup.Item value="warn">Warnings</ToggleGroup.Item>
          <ToggleGroup.Item value="error">Errors</ToggleGroup.Item>
        </ToggleGroup.Root>
        <Input bind:value={query} placeholder="Filter" class="h-8 min-w-0 flex-1" aria-label="Filter the console" />
      </div>
      {#if live.dropped > 0}
        <p class="text-muted-foreground shrink-0 px-4 pb-1 text-xs">
          Some lines were skipped to keep up.
        </p>
      {/if}
      {#if consoleLines.length === 0}
        {@render nothing(live.console.length === 0 ? "Nothing logged" : "No lines match")}
      {:else}
        <ol
          {@attach followTail(() => consoleLines.length)}
          class="scroll-fade-y min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2 font-mono text-xs"
        >
          {#each consoleLines as line (line.id)}
            <li
              class={[
                "flex gap-3 border-b px-4 py-1 last:border-b-0",
                line.level === "error" && "bg-destructive/5 text-destructive",
                line.level === "warn" && "bg-warning/10",
                line.level === "debug" && "text-muted-foreground",
              ]}
            >
              <span class="min-w-0 flex-1 break-words whitespace-pre-wrap">{line.text}</span>
              {#if line.source}
                <span class="text-muted-foreground max-w-32 shrink-0 truncate" title={line.source.url}>
                  {shortUrl(line.source.url, tab?.url ?? null).split("/").at(-1)}{line.source.line ===
                      undefined
                    ? ""
                    : `:${line.source.line}`}
                </span>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}
    </Tabs.Content>

    <Tabs.Content value="network" class="flex min-h-0 flex-1 flex-col">
      {#if live.network.length === 0}
        {@render nothing("No requests yet")}
      {:else}
        <ol
          {@attach followTail(() => live.network.length)}
          class="scroll-fade-y min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 text-xs"
        >
          {#each live.network as request (request.id)}
            {@const failed = isFailedRequest(request)}
            <li
              class={[
                "grid grid-cols-[3.5rem_2.5rem_minmax(0,1fr)_auto] items-baseline gap-2 px-4 py-1",
                failed && "bg-destructive/5 text-destructive",
              ]}
            >
              <span class="font-mono">{request.method}</span>
              <span class={["font-mono tabular-nums", !failed && "text-muted-foreground"]}>
                {request.status ?? "—"}
              </span>
              <span class="flex min-w-0 flex-col">
                <span class="truncate font-mono" title={request.url}>
                  {shortUrl(request.url, tab?.url ?? null)}
                </span>
                {#if request.failure}
                  <span class="truncate">{request.failure}</span>
                {/if}
              </span>
              <span class="text-muted-foreground tabular-nums">
                {request.durationMs === undefined ? "" : `${Math.round(request.durationMs)} ms`}
              </span>
            </li>
          {/each}
        </ol>
      {/if}
    </Tabs.Content>
  </Tabs.Root>
</section>

{#snippet actionRow(item: ActionItem)}
  {@const Icon = browserToolIcon(item.tool)}
  <Icon
  class={["size-3.5 shrink-0", item.isError ? "text-destructive" : "text-muted-foreground"]} />
  <span class={["min-w-0 flex-1 truncate", item.isError && "text-destructive"]}>
    {item.label}
    {#if item.subject}
      <span class="text-muted-foreground ml-1 font-mono text-xs">{item.subject}</span>
    {/if}
  </span>
  <span class="text-muted-foreground shrink-0 text-xs tabular-nums">{clock(item.at)}</span>
{/snippet}

{#snippet nothing(title: string)}
  <Empty.Root class="min-h-0 flex-1 gap-1 p-6">
  <Empty.Header>
    <Empty.Description>{title}</Empty.Description>
  </Empty.Header>
</Empty.Root>
{/snippet}
