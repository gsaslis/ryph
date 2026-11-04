<script lang="ts">
import { getLaneWindow, subscribeRunEvents } from "$lib/api/history";
import LiveChip from "$lib/components/browser-pane/live-chip.svelte";
import { RunHistory } from "$lib/components/run-history/run-history.svelte";
import RunTranscript from "$lib/components/run-transcript/run-transcript.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Empty from "$lib/components/ui/empty";
import { Spinner } from "$lib/components/ui/spinner";
import { formatDateTime, formatTime } from "$lib/utils/format";
import {
  modeLabel,
  pickSubagent,
  type Subagent,
  subagentStatus,
  type SubagentTone,
} from "$lib/utils/subagents";
import BanIcon from "@lucide/svelte/icons/ban";
import BotIcon from "@lucide/svelte/icons/bot";
import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
import CircleStopIcon from "@lucide/svelte/icons/circle-stop";
import CircleXIcon from "@lucide/svelte/icons/circle-x";
import ClockIcon from "@lucide/svelte/icons/clock";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import { untrack } from "svelte";

let {
  subagents,
  selected = $bindable(null),
  loaded,
  runId,
  grant,
  root,
  runEnded,
  agentId,
  parentName,
  showDiag = false,
}: {
  /** Every subagent of the run, in the order they were started. */
  subagents: Subagent[];
  /** The subagent the tab shows; null for "whichever is newest". */
  selected?: string | null;
  /** The list has been read, or its feed opened, at least once. */
  loaded: boolean;
  runId: string;
  /** The run's history grant, read whenever a read needs it: every load mints a fresh one. */
  grant: () => string | null;
  /** The run's checkout, which a subagent's tool rows are relative to. */
  root: () => string | null;
  /** The run is over, as the page knows it. */
  runEnded: boolean;
  agentId: string;
  /** The run's agent: who handed each subagent its work. */
  parentName: string;
  /** Match the task page's diagnostics preference in every subagent lane. */
  showDiag?: boolean;
} = $props();

const newestFirst = $derived(subagents.toReversed());
const shown = $derived(pickSubagent(subagents, selected));
const running = $derived(subagents.some((s) => s.runningSince !== null));

// A running subagent's clock, ticking only while one runs.
let now = $state(Date.now());
$effect(() => {
  if (!running) return;
  now = Date.now();
  const tick = setInterval(() => (now = Date.now()), 1_000);
  return () => clearInterval(tick);
});

// The shown subagent's transcript: one history per lane, for the reason the run's is one per run.
// Keyed on the lane alone, so the list re-reading leaves what the reader scrolled to alone.
const lane = $derived(shown?.id ?? null);
const history = $derived.by(() => {
  const id = lane;
  if (id === null) return null;
  return untrack(() => new RunHistory(runId, fetch, grant, { lane: id, root }));
});

$effect(() => {
  if (history !== null) history.showDiag = showDiag;
});

/** Its first read: under way, done, or failed and waiting to be asked again. */
let reading = $state<{ history: RunHistory; failed: string | null } | null>(null);
function read(held: RunHistory) {
  reading = { history: held, failed: null };
  getLaneWindow(fetch, runId, held.lane, grant()).then(
    (window) => held.seed(window),
    (e) => {
      if (reading?.history !== held) return;
      reading = {
        history: held,
        failed: e instanceof Error ? e.message : "Could not read its transcript.",
      };
    },
  );
}
$effect(() => {
  const held = history;
  if (held !== null) untrack(() => read(held));
});
const failed = $derived(reading?.history === history ? reading.failed : null);

// Nothing but whether it is still at work comes from outside the lane.
const live = $derived(shown?.runningSince != null);
$effect(() => {
  const held = history;
  const on = live;
  if (held === null) return;
  untrack(() =>
    held.setDetail({ lifecycle: [], messages: [], result: null, egressNote: null, live: on })
  );
});

// The lane's live tail, for as long as the run is live: a subagent that ended can be continued,
// and its next stretch arrives on the same stream. Opened once the window has seeded, from its end.
$effect(() => {
  const held = history;
  if (held === null || runEnded || !held.seeded) return;
  let poll: ReturnType<typeof setInterval> | undefined;
  const sub = untrack(() =>
    subscribeRunEvents(runId, {
      after: held.lastSeq,
      lane: held.lane,
      grant: grant(),
      onEvent: (event) => held.absorb(event),
      onError: () => {
        // The stream will not hold: the newest events are read again on a slow beat instead.
        poll ??= setInterval(() => {
          getLaneWindow(fetch, runId, held.lane, grant()).then(
            (window) => held.seed(window),
            () => {},
          );
        }, 5_000);
      },
    })
  );
  return () => {
    sub.close();
    if (poll !== undefined) clearInterval(poll);
  };
});

// The tail closes with the run, and what the runner writes last (a lane closed with the run, the
// final batch) can land after that: read once more as the run turns over, as the page does.
// Only a lane read while the run was live: one first read after it ended is already final. Plain,
// not state: it is what this effect last saw.
let readWhileLive = false;
$effect(() => {
  const held = history;
  if (held === null || !held.seeded) return;
  if (!runEnded) {
    readWhileLive = true;
    return;
  }
  if (!readWhileLive) return;
  readWhileLive = false;
  untrack(() => {
    getLaneWindow(fetch, runId, held.lane, grant()).then(
      (window) => held.seed(window),
      () => {},
    );
  });
});

const ENDED_ICONS = {
  answered: { Icon: CircleCheckIcon, tone: "text-success" },
  timeout: { Icon: ClockIcon, tone: "text-destructive" },
  stopped: { Icon: BanIcon, tone: "text-muted-foreground" },
  failed: { Icon: CircleXIcon, tone: "text-destructive" },
  run_ended: { Icon: CircleStopIcon, tone: "text-muted-foreground" },
} as const;

function endedIcon(subagent: Subagent) {
  return ENDED_ICONS[subagent.end?.reason ?? "failed"];
}

const badgeVariant = (tone: SubagentTone) => (tone === "failed" ? "destructive" : "secondary");
const iso = (ms: number) => new Date(ms).toISOString();
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Subagents">
  {#if subagents.length === 0 && !loaded}
    <!-- Usually here in a moment: an empty pane rather than a state that only flashes. -->
    <div class="flex-1"></div>
  {:else if subagents.length === 0}
    <Empty.Root class="flex-1">
      <Empty.Header>
        <Empty.Media variant="icon">
          <BotIcon />
        </Empty.Media>
        <Empty.Title>No subagents yet</Empty.Title>
        <Empty.Description>Work the agent hands off to a subagent shows up here.</Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {:else}
    <!-- Newest first. Capped so the transcript below always has room. -->
    <ul
      class="scroll-fade-y flex max-h-[35%] shrink-0 flex-col overflow-y-auto overscroll-contain p-2"
      aria-label="Subagents"
    >
      {#each newestFirst as s (s.id)}
        {@const status = subagentStatus(s, now)}
        {@const current = shown?.id === s.id}
        <li>
          <button
            type="button"
            aria-current={current ? "true" : undefined}
            onclick={() => (selected = s.id)}
            class={[
              "flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              current ? "bg-muted" : "hover:bg-muted/60",
            ]}
          >
            <span class="flex h-5 shrink-0 items-center">
              {#if status.tone === "running"}
                <Spinner class="text-primary size-4" aria-label="Running" />
              {:else}
                {@const { Icon, tone } = endedIcon(s)}
                <Icon class={["size-4", tone]} aria-hidden="true" />
              {/if}
            </span>
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="flex items-baseline gap-2">
                <bdi class="min-w-0 flex-1 truncate font-medium">{s.label}</bdi>
                <span
                  class={[
                    "shrink-0 text-xs tabular-nums",
                    status.tone === "failed" ? "text-destructive" : "text-muted-foreground",
                  ]}
                >
                  {status.tone === "running" ? status.duration : `${status.label} · ${status.duration}`}
                </span>
              </span>
              <span class="text-muted-foreground flex items-center gap-1.5 text-xs">
                <span>{modeLabel(s.mode)}</span>
                {#if s.continued}
                  <span aria-hidden="true">·</span>
                  <span>Continued</span>
                {/if}
              </span>
            </span>
          </button>
        </li>
      {/each}
    </ul>

    {#if shown !== null}
      {@const status = subagentStatus(shown, now)}
      <div class="flex min-h-0 flex-1 flex-col border-t">
        <header class="flex shrink-0 flex-col gap-1 border-b px-4 pt-3 pb-3">
          <div class="flex min-w-0 items-center gap-2">
            <h3 class="min-w-0 flex-1 truncate text-sm font-medium" title={shown.label}>
              <bdi>{shown.label}</bdi>
            </h3>
            {#if status.tone === "running"}
              <LiveChip chip={runEnded ? "ended" : "live"} />
            {:else}
              <Badge variant={badgeVariant(status.tone)}>{status.label}</Badge>
            {/if}
          </div>
          <p class="text-muted-foreground text-xs tabular-nums">
            <span title={formatDateTime(iso(shown.startedAt))}>
              Started {formatTime(iso(shown.startedAt))}, {status.tone === "running"
                ? "running for"
                : "ran for"}
              {status.duration}
            </span>
          </p>
        </header>

        {#if failed !== null && history !== null}
          {@const held = history}
          <Empty.Root class="flex-1 gap-1 border-0 p-6">
            <Empty.Header>
              <Empty.Media variant="icon">
                <TriangleAlertIcon />
              </Empty.Media>
              <Empty.Title>Could not load its transcript</Empty.Title>
              <Empty.Description>{failed}</Empty.Description>
            </Empty.Header>
            <Empty.Content>
              <Button variant="outline" size="sm" onclick={() => read(held)}>Try again</Button>
            </Empty.Content>
          </Empty.Root>
        {:else if history !== null && history.seeded}
          <!-- Keyed on the lane: each subagent's transcript is a list of its own. The transcript
               punches its markers out of its spine with the page's background; here it sits on
               the pane's. -->
          <div class="flex min-h-0 flex-1 flex-col [--background:var(--sidebar)]">
            {#key history}
              <RunTranscript
                {history}
                contained
                {agentId}
                agentName="Subagent"
                bot
                {parentName}
                senderLabel={() => parentName}
              />
            {/key}
          </div>
        {:else}
          <!-- Usually here in a moment: an empty pane rather than a state that only flashes. -->
          <div class="flex-1"></div>
        {/if}
      </div>
    {:else if selected !== null}
      <!-- A subagent opened from the transcript that the list does not hold yet. -->
      <div class="flex min-h-0 flex-1 border-t">
        {#if loaded}
          <Empty.Root class="flex-1 gap-1 border-0 p-6">
            <Empty.Header>
              <Empty.Title>Not listed yet</Empty.Title>
              <Empty.Description>It shows here once the run has recorded it.</Empty.Description>
            </Empty.Header>
          </Empty.Root>
        {/if}
      </div>
    {/if}
  {/if}
</section>
