<script lang="ts">
import {
  type BackgroundJob,
  backgroundLogHref,
  type CommandsSource,
  getBackgroundLog,
} from "$lib/api/background";
import LiveChip from "$lib/components/browser-pane/live-chip.svelte";
import type { Chip } from "$lib/components/browser-pane/live-view";
import CopyButton from "$lib/components/copy-button/copy-button.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Empty from "$lib/components/ui/empty";
import { Spinner } from "$lib/components/ui/spinner";
import { Toggle } from "$lib/components/ui/toggle";
import { jobStatus } from "$lib/utils/background";
import { formatDateTime, formatTime } from "$lib/utils/format";
import BanIcon from "@lucide/svelte/icons/ban";
import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
import CircleStopIcon from "@lucide/svelte/icons/circle-stop";
import CircleXIcon from "@lucide/svelte/icons/circle-x";
import ClockIcon from "@lucide/svelte/icons/clock";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import ScrollTextIcon from "@lucide/svelte/icons/scroll-text";
import SquareTerminalIcon from "@lucide/svelte/icons/square-terminal";
import WrapTextIcon from "@lucide/svelte/icons/wrap-text";
import { untrack } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import type { CommandsState } from "./commands-state.svelte";
import { OutputBuffer, pickJob } from "./commands-view";
import CommandOutput from "./command-output.svelte";
import RunPreviews from "$lib/components/run-previews.svelte";
import type { RunPreview } from "$lib/api/previews";

let {
  state: commands,
  previews = [],
  previewsAvailable = true,
  previewHref = () => undefined,
  jobs,
  source,
  runId,
  loaded,
  refresh,
  runEnded,
}: {
  /** The run's commands as the page holds them: the job shown, and the live room. */
  state: CommandsState;
  previews?: RunPreview[];
  previewsAvailable?: boolean;
  /** Where a preview's open action goes. */
  previewHref?: (preview: RunPreview) => string | undefined;
  /** Every job, the durable record met with the live room, newest first. */
  jobs: BackgroundJob[];
  /** The live room. Opened when the tab mounts and closed when it goes. */
  source: CommandsSource | null;
  runId: string;
  /** The list has been read at least once. */
  loaded: boolean;
  /** Reads the list again. */
  refresh: () => void;
  /** The run is over, as the page knows it. */
  runEnded: boolean;
} = $props();

// The list is read when the tab opens, and the stream is open exactly while it is on screen.
$effect(() => {
  untrack(refresh);
});
$effect(() => {
  const held = commands;
  const live = source;
  if (live === null) return;
  return untrack(() => held.connect(live));
});

const job = $derived(pickJob(jobs, commands.selected));
const running = $derived(jobs.some((j) => j.endedAt === null));

// A running job's clock, ticking only while one runs.
let now = $state(Date.now());
$effect(() => {
  if (!running) return;
  now = Date.now();
  const tick = setInterval(() => (now = Date.now()), 1_000);
  return () => clearInterval(tick);
});

const chip = $derived<Chip>(
  runEnded || commands.done
    ? "ended"
    : commands.connection === "connecting" || commands.connection === "closed"
    ? "connecting"
    : "live",
);
// A runner that is not relaying is, to someone watching a running command, a stream to get back.
const reconnecting = $derived(commands.connection === "retrying" || commands.uplink === false);

// Stored logs, read once a job has ended and the control plane holds its log. An ended job's log
// does not change, so the last few read are kept for going back and forth between them; a log is
// up to 4 MiB, so only a few.
type LogRead =
  | { state: "loading" }
  | { state: "ok"; text: string }
  | { state: "none" }
  | { state: "error"; message: string };
const logs = new SvelteMap<string, LogRead>();
/** The selected job's log, and this many others. */
const LOGS_KEPT = 2;

/** A read landed or started: the oldest others are let go past the bound. Not the shown one. */
function keep(id: string, read: LogRead) {
  logs.delete(id);
  logs.set(id, read);
  const others = [...logs.keys()].filter((key) => key !== commands.selected && key !== id);
  for (const key of others.slice(0, Math.max(0, others.length - LOGS_KEPT))) logs.delete(key);
}

function readLog(id: string) {
  keep(id, { state: "loading" });
  getBackgroundLog(fetch, runId, id).then(
    (text) => {
      if (logs.has(id)) keep(id, text === null ? { state: "none" } : { state: "ok", text });
    },
    (e) => {
      if (!logs.has(id)) return;
      keep(id, {
        state: "error",
        message: e instanceof Error ? e.message : "Could not read the log.",
      });
    },
  );
}

$effect(() => {
  if (job === null || job.endedAt === null || !job.hasLog) return;
  const id = job.id;
  untrack(() => {
    if (!logs.has(id)) readLog(id);
  });
});

const read = $derived(job === null ? undefined : logs.get(job.id));
/** What the output pane draws for the job shown. */
const shown = $derived.by(():
  | { kind: "live" }
  | { kind: "log"; text: string; note: string | null }
  | { kind: "loading" }
  | { kind: "none" } => {
  if (job === null) return { kind: "none" };
  if (job.endedAt === null) return { kind: "live" };
  if (read?.state === "ok") {
    return {
      kind: "log",
      text: read.text,
      note: job.logTruncated ? "Only the end of the output was kept." : null,
    };
  }
  if (job.hasLog && (read === undefined || read.state === "loading")) {
    // What was seen live stands in while the stored log is read.
    return commands.withOutput.has(job.id) ? { kind: "live" } : { kind: "loading" };
  }
  if (commands.withOutput.has(job.id)) return { kind: "live" };
  if (job.logTail !== null && job.logTail !== "") {
    return { kind: "log", text: job.logTail, note: null };
  }
  return { kind: "none" };
});

// Long lines wrap unless the reader turns it off: output is read more than it is scanned sideways.
let wrap = $state(true);

/** The most of a stored log drawn: the whole of what the control plane keeps. */
const LOG_MAX_CHARS = 8 * 1024 * 1024;
// A stored log, held as a buffer of one chunk so the one view draws it as it draws live output.
// Keyed on the text: a poll that hands back the same log keeps the reader's place.
const logText = $derived(shown.kind === "log" ? shown.text : null);
const logBuffer = $derived.by(() => {
  const buffer = new OutputBuffer(LOG_MAX_CHARS, 1);
  if (logText !== null) buffer.reset(logText);
  return buffer;
});

const iso = (ms: number) => new Date(ms).toISOString();

/** When the job started, and how long it has run or ran. */
function timing(j: BackgroundJob, duration: string): string {
  const started = `Started ${formatTime(iso(j.startedAt))}`;
  if (j.endedAt !== null) return `${started}, ran for ${duration}`;
  const stops = j.timeoutAt !== null && !j.service
    ? `, stops at ${formatTime(iso(j.timeoutAt))}`
    : "";
  return `${started}, running for ${duration}${stops}`;
}

function toneIcon(j: BackgroundJob) {
  if (j.reason === "timeout") return { Icon: ClockIcon, tone: "text-destructive" };
  if (j.reason === "stopped") return { Icon: BanIcon, tone: "text-muted-foreground" };
  if (j.reason === "run_ended") return { Icon: CircleStopIcon, tone: "text-muted-foreground" };
  return j.exitCode === 0
    ? { Icon: CircleCheckIcon, tone: "text-success" }
    : { Icon: CircleXIcon, tone: "text-destructive" };
}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Background commands">
  <RunPreviews {previews} available={previewsAvailable} href={previewHref} />
  {#if jobs.length === 0 && !loaded}
    <!-- Usually here in a moment: an empty pane rather than a state that only flashes. -->
    <div class="flex-1"></div>
  {:else if jobs.length === 0}
    <Empty.Root class="flex-1">
      <Empty.Header>
        <Empty.Media variant="icon">
          <SquareTerminalIcon />
        </Empty.Media>
        <Empty.Title>No background commands</Empty.Title>
        <Empty.Description>
          Builds, test runs and servers the agent starts in the background show up here.
        </Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {:else}
    <!-- The jobs, newest first. Capped so the output below always has room. -->
    <ul
      class="scroll-fade-y flex max-h-[40%] shrink-0 flex-col overflow-y-auto overscroll-contain px-2 pt-2 pb-2"
      aria-label="Commands"
    >
      {#each jobs as j (j.id)}
        {@const status = jobStatus(j, now)}
        {@const current = job?.id === j.id}
        <li>
          <button
            type="button"
            aria-current={current ? "true" : undefined}
            onclick={() => (commands.selected = j.id)}
            class={[
              "flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              current ? "bg-muted" : "hover:bg-muted/60",
            ]}
          >
            <span class="flex h-5 shrink-0 items-center">
              {#if status.tone === "running"}
                <Spinner class="text-primary size-4" aria-label="Running" />
              {:else}
                {@const { Icon, tone } = toneIcon(j)}
                <Icon class={["size-4", tone]} aria-hidden="true" />
              {/if}
            </span>
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="flex items-baseline gap-2">
                <bdi class="min-w-0 flex-1 truncate font-medium">{j.label}</bdi>
                <span
                  class={[
                    "shrink-0 text-xs tabular-nums",
                    status.tone === "failed" ? "text-destructive" : "text-muted-foreground",
                  ]}
                >
                  {status.tone === "running" ? status.duration : `${status.label} · ${status.duration}`}
                </span>
              </span>
              <span class="flex items-center gap-2">
                <bdi class="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
                  {j.command}
                </bdi>
                {#if j.service}
                  <Badge variant="outline">Service</Badge>
                {/if}
              </span>
            </span>
          </button>
        </li>
      {/each}
    </ul>

    {#if job !== null}
      {@const status = jobStatus(job, now)}
      {@const ended = job.endedAt === null
        ? null
        : { text: `${status.label} after ${status.duration}`, tone: status.tone }}
      <div class="flex min-h-0 flex-1 flex-col border-t">
        <header class="flex shrink-0 flex-col gap-2 px-4 pt-3 pb-3">
          <div class="flex min-w-0 items-center gap-2">
            <h3 class="min-w-0 flex-1 truncate text-sm font-medium" title={job.label}>
              <bdi>{job.label}</bdi>
            </h3>
            {#if job.endedAt === null}
              {#if commands.busy && chip !== "ended"}
                <Badge variant="outline">Too many viewers</Badge>
              {:else}
                <LiveChip {chip} retrying={reconnecting} />
              {/if}
            {:else}
              <Badge variant={status.tone === "failed" ? "destructive" : "secondary"}>
                {status.label}
              </Badge>
            {/if}
          </div>
          <div class="flex items-center gap-2">
            <p class="text-muted-foreground min-w-0 flex-1 text-xs tabular-nums">
              <span title={formatDateTime(iso(job.startedAt))}>{timing(job, status.duration)}</span>
              {#if job.cwd}
                <span class="block truncate font-mono" title={job.cwd}>in <bdi>{job.cwd}</bdi></span>
              {/if}
            </p>
            <div class="flex shrink-0 items-center gap-1">
              <Toggle
                size="sm"
                class="size-8 px-0"
                bind:pressed={wrap}
                aria-label="Wrap long lines"
                title="Wrap long lines"
              >
                <WrapTextIcon />
              </Toggle>
              {#if shown.kind === "log"}
                <CopyButton
                  size="icon-sm"
                  value={shown.text}
                  label="Copy the output"
                  what="Output copied"
                />
              {:else if shown.kind === "live"}
                {@const buffer = commands.buffer(job.id)}
                <CopyButton
                  size="icon-sm"
                  value={() => buffer.text}
                  label="Copy the output"
                  what="Output copied"
                />
              {/if}
              {#if job.hasLog}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  href={backgroundLogHref(runId, job.id)}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open the raw log"
                  title="Open the raw log"
                >
                  <ExternalLinkIcon />
                </Button>
              {/if}
            </div>
          </div>
          {#if read?.state === "error"}
            <p class="text-destructive text-xs">
              Could not read the log. {read.message}
              <Button
                variant="link"
                size="sm"
                class="h-auto px-0 text-xs"
                onclick={() => readLog(job.id)}
              >
                Try again
              </Button>
            </p>
          {/if}
          <!-- Lines lost on the way here belong to no job in particular, so it is said wherever live
               output is shown, until the next snapshot says the room whole again. -->
          {#if shown.kind === "live" && commands.dropped > 0}
            <p class="text-muted-foreground text-xs">Some output was lost on the way here.</p>
          {/if}
          {#if shown.kind === "log" && shown.note !== null}
            <p class="text-muted-foreground text-xs">{shown.note}</p>
          {/if}
        </header>

        <!-- The output is the agent's command's own text: it is only ever drawn as text. Everything
             the agent wrote is isolated (`bdi`, or a block of its own), so no direction mark in it
             can reorder the words around it. -->
        {#if shown.kind === "live"}
          {#key job.id}
            <CommandOutput
              buffer={commands.buffer(job.id)}
              command={job.command}
              {wrap}
              running={job.endedAt === null}
              {ended}
              class="flex-1 border-t"
            >
              {#snippet empty()}
                {@render nothing(job.endedAt === null)}
              {/snippet}
            </CommandOutput>
          {/key}
        {:else if shown.kind === "log"}
          {#key job.id}
            <CommandOutput
              buffer={logBuffer}
              command={job.command}
              {wrap}
              {ended}
              class="flex-1 border-t"
            >
              {#snippet empty()}
                {@render nothing(false)}
              {/snippet}
            </CommandOutput>
          {/key}
        {:else if shown.kind === "loading"}
          <!-- Usually here in a moment: an empty pane rather than a state that only flashes. -->
          <div class="flex-1 border-t"></div>
        {:else}
          {@render nothing(false)}
        {/if}
      </div>
    {:else if commands.selected !== null}
      <!-- A job opened from the transcript that the list does not hold yet. -->
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

{#snippet nothing(waiting: boolean)}
  <Empty.Root class="flex-1 gap-1 border-0 p-6">
  <Empty.Header>
      <Empty.Media variant="icon">
        {#if waiting && chip !== "ended"}
          <Spinner />
        {:else}
          <ScrollTextIcon />
        {/if}
      </Empty.Media>
      <Empty.Title>
        {#if !waiting}
          No output
        {:else if chip === "ended"}
          No output yet
        {:else}
          Waiting for output
        {/if}
      </Empty.Title>
      {#if waiting && chip !== "ended" && commands.busy}
        <Empty.Description>Too many people are watching this run. Trying again shortly.</Empty.Description>
      {:else if waiting && reconnecting && chip !== "ended"}
        <Empty.Description>Reconnecting to the run.</Empty.Description>
      {/if}
    </Empty.Header>
</Empty.Root>
{/snippet}
