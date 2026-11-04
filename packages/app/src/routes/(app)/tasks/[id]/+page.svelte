<script lang="ts">
import { dev } from "$app/environment";
import { goto, invalidate } from "$app/navigation";
import { page } from "$app/state";
import { historianLiveSource, type LiveSource } from "$lib/api/browser-live";
import { type BackgroundJob, commandsLiveSource, getRunBackground } from "$lib/api/background";
import { getRunLanes, subscribeRunLanes } from "$lib/api/history";
import { postRunMessage } from "$lib/api/messages";
import { cancelTask, createTask, type CreateTaskInput, finishTask } from "$lib/api/tasks";
import type { ToolCall } from "$lib/api/tools";
import { startWithoutEnvironment } from "$lib/api/environments";
import {
  isPatchAdvancing,
  type RunMessage,
  type TaskDetail,
  TERMINAL_RUN_STATES,
} from "$lib/api/types";
import EnvironmentWait from "$lib/components/environment-wait/environment-wait.svelte";
import AgentAvatar from "$lib/components/agent-avatar/agent-avatar.svelte";
import { setCheckSuitesContext } from "$lib/components/tool-call/check-suites-context";
import { setPatchesContext } from "$lib/components/tool-call/patches-context";
import { setRunSkillsContext } from "$lib/components/tool-call/run-skills-context";
import { runSkillsView } from "$lib/utils/skills";
import ThreadLabel from "$lib/components/thread-label/thread-label.svelte";
import { RunHistory } from "$lib/components/run-history/run-history.svelte";
import { type MemoryCall, memoryCallOf } from "$lib/utils/memory-calls";
import {
  closingNotes,
  type ForgeCall,
  forgeCallOf,
  matchForgeWrites,
} from "$lib/utils/forge-calls";
import { getTaskListContext } from "$lib/components/task-list/live-task-list.svelte";
import RunTranscript from "$lib/components/run-transcript/run-transcript.svelte";
import RunStateBadge from "$lib/components/run-state-badge/run-state-badge.svelte";
import { runSizeLabel, sizeSummary } from "$lib/utils/run-sizes";
import RunSkills from "$lib/components/run-skills/run-skills.svelte";
import * as Alert from "$lib/components/ui/alert";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Empty from "$lib/components/ui/empty";
import { Spinner } from "$lib/components/ui/spinner";
import RunComposer, { type ComposerBox } from "$lib/components/run-composer/run-composer.svelte";
import { taskDraftKey } from "$lib/components/run-composer/draft";
import BrowserPane from "$lib/components/browser-pane/browser-pane.svelte";
import {
  PreviewsState,
  setPreviewsContext,
} from "$lib/components/tool-call/previews-context.svelte";
import CommandsPane from "$lib/components/commands-pane/commands-pane.svelte";
import { CommandsState } from "$lib/components/commands-pane/commands-state.svelte";
import {
  COMMANDS_POLL_MS,
  CommandsCues,
  mergeJobs,
  needsPolling,
  settleWithRun,
} from "$lib/components/commands-pane/commands-view";
import { setBackgroundJobsContext } from "$lib/components/tool-call/background-jobs-context";
import { backgroundCallOf } from "$lib/utils/background";
import SubagentsPane from "$lib/components/subagents-pane/subagents-pane.svelte";
import { setSubagentsContext } from "$lib/components/tool-call/subagents-context";
import { LanesState } from "$lib/components/subagents-pane/lanes-state.svelte";
import { previewCallOf } from "$lib/utils/previews";
import type { TranscriptAction } from "$lib/components/browser-pane/live-view";
import {
  detailsPane,
  type DetailsPaneContext,
} from "$lib/components/details-pane/details-pane.svelte";
import RunActions from "$lib/components/run-pane/run-actions.svelte";
import ArtifactPane from "$lib/components/run-pane/artifact-pane.svelte";
import { artifactsOfRun } from "$lib/utils/artifacts";
import { pageHeader } from "$lib/components/page-header/page-header.svelte";
import RunUsage from "$lib/components/run-pane/run-usage.svelte";
import { runPaneTab } from "$lib/components/run-pane/pane-tab.svelte";
import * as Tooltip from "$lib/components/ui/tooltip";
import { describeBrowserCall } from "$lib/utils/browser-tools";
import AttachmentImages from "$lib/components/attachment-images/attachment-images.svelte";
import * as Tabs from "$lib/components/ui/tabs";
import { DEFAULT_ENVIRONMENT_ID, runEnvironmentLabel } from "$lib/utils/environments";
import { isSuiteSettled, suitesForRun } from "$lib/utils/checks";
import { isLegacyTask, LEGACY_RERUN, LEGACY_START_AGAIN } from "$lib/utils/legacy-task";
import { forgeRepoLabel, providerOfRepoRef, repoThreadLabel, threadLabel } from "$lib/utils/forge";
import {
  branchName,
  formatDateTime,
  formatElapsed,
  formatRelativeTime,
  formatUsd,
} from "$lib/utils/format";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import MessagesSquareIcon from "@lucide/svelte/icons/messages-square";
import ChartColumnIcon from "@lucide/svelte/icons/chart-column";
import InfoIcon from "@lucide/svelte/icons/info";
import MonitorIcon from "@lucide/svelte/icons/monitor";
import ActivityIcon from "@lucide/svelte/icons/activity";
import BotIcon from "@lucide/svelte/icons/bot";
import PanelRightCloseIcon from "@lucide/svelte/icons/panel-right-close";
import PanelRightOpenIcon from "@lucide/svelte/icons/panel-right-open";
import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
import RotateCcwIcon from "@lucide/svelte/icons/rotate-ccw";
import ScrollTextIcon from "@lucide/svelte/icons/scroll-text";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import { HOOK_BANNER_TITLE, HOOK_HELD_LABEL, isHeld } from "$lib/utils/hook-check";
import FileDiffIcon from "@lucide/svelte/icons/file-diff";
import SquareTerminalIcon from "@lucide/svelte/icons/square-terminal";
import XIcon from "@lucide/svelte/icons/x";
import MoreHorizontalIcon from "@lucide/svelte/icons/more-horizontal";
import { finishButton } from "$lib/utils/run-finish";
import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
import CirclePauseIcon from "@lucide/svelte/icons/circle-pause";
import {
  asksForPrompt,
  awaitsPrompt,
  type Carried,
  ENDED_BEFORE_PROMPT,
  promptReadiness,
  refusedAsEnded,
  StartAgain,
  takeHandoff,
  taskName,
} from "$lib/utils/task-prompt";
import PaneHeader from "$lib/components/task-page/pane-header.svelte";
import PromptStage from "$lib/components/task-page/prompt-stage.svelte";
import TaskColumn from "$lib/components/task-page/task-column.svelte";
import TaskMasthead from "$lib/components/task-page/task-masthead.svelte";
import { tick, untrack } from "svelte";
import type { Attachment } from "svelte/attachments";
import { prefersReducedMotion } from "svelte/motion";
import { fade } from "svelte/transition";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";
import { BuildProgress } from "./build-progress.svelte";
import { hold } from "./holding";
import { RunBill } from "./run-bill.svelte";
import { RunTail } from "./run-tail.svelte";
import { refreshCadence, RefreshScheduler } from "./refresh";

let { data }: PageProps = $props();

/**
 * The last load that actually told us something about the task.
 *
 * The page re-runs its load while the run is live, and a read that fails there must not take the
 * page down. The load hands back a detail of `null` instead of
 * throwing (on a RE-run only: the first look at a task still fails the page, because there is
 * nothing behind it to keep showing), and this is what "keeping what we had" means. There is
 * always one to keep by the time anything reads it, for exactly that reason.
 */
let held = $state<{ detail: TaskDetail } | null>(null);
$effect(() => {
  const detail = data.detail;
  if (detail === null) return;
  untrack(() => (held = { detail }));
});
// The `!` is the type system's, not a state this page can be in: a load that comes back with
// nothing is a RE-load by construction, so something was adopted above on a run before it.
const detail = $derived((data.detail ?? held?.detail)!);
/**
 * The last poll did not answer. Not an error state — the page is still showing the run, and the
 * next poll is the one that clears this — so it is one quiet line, and nothing moves under it.
 */
const connectionLost = $derived(data.detail === null);

/**
 * The one thing on this page that re-runs its load: every cue, action and clock below asks it, so
 * cues never stack loads on one in flight, and there is one clock, at the shortest cadence anything
 * on the page needs (see `refreshCadence`, set below once everything it reads is declared).
 */
const refresh = new RefreshScheduler(() => invalidate("app:task"));
$effect(() => () => refresh.dispose());
/** For a cue: re-run the load now, or straight after the one in flight. */
const reload = () => void refresh.request();
/** For an action: re-run the load now, whatever is in flight. */
const reloadNow = () => void refresh.now();

const task = $derived(detail.task);
// A task from before every task checked out a connected repo: it reads as it did, and cannot
// be run again.
const legacy = $derived(isLegacyTask(task));
// Agents are archived rather than deleted, so a run's agent almost always resolves; its id is the
// honest last resort for a name. The face seeds off `task.agentId` either way — always present,
// and stable across the rename an editable blueprint invites.
const agentName = $derived(detail.agent?.name ?? task.agentId);
const run = $derived(detail.runs.at(-1) ?? null);
// Scalars, so a load re-run with unchanged values does not churn the tail effect below —
// `run` itself is a fresh object every load and would tear the stream down and back up.
const runId = $derived(run?.id ?? null);
// The bill: read with the load, and on its own clock while the run is live (see below). A load
// that left it to that clock hands over `null`, and the page keeps the bill it has.
const bill = new RunBill(() => runId, fetch);
$effect(() => {
  const pending = data.usage;
  if (pending === null) return;
  bill.take(runId, pending);
});
const usage = $derived(bill.current);
const historyGrant = $derived(run?.grants?.history ?? null);
const previews = new PreviewsState();
setPreviewsContext(previews);
$effect(() => {
  if (runId === null) return;
  // Grant renewal must not restart discovery and clear the visible list.
  const taskId = untrack(() => task.id);
  return previews.connect(runId, () => untrack(() => historyGrant), terminal, taskId);
});
// Discovery waits for the agent to expose a port: most runs never do, and each poll is a lookup.
$effect(() => {
  if (runId !== null && transcriptCalls.preview) previews.called(runId);
});
const usageGrant = $derived(run?.grants?.models ?? null);
const terminal = $derived(run !== null && TERMINAL_RUN_STATES.includes(run.state));
// A run stays alive after the agent settles, waiting to be spoken to; the message box below is
// how a person does that from here. Whether it is on screen matters to the transcript as much as
// to the markup: it is what the transcript follows the tail PAST, to the bottom of the page.
const showComposer = $derived(run !== null && !terminal);
// The images the run's task started with: a forge thread's screenshots, a chat mention's photo.
const taskImages = $derived(run?.workItem?.attachments ?? []);
/**
 * How tall that box is: it grows line by line as a message is typed, and the transcript follows
 * its tail to the bottom of the page — which that growth moves.
 */
let composerHeight = $state(0);
// The patches THIS run produced — a task's list spans every attempt, and an earlier run's
// patches are that run's story, not this one's.
const runPatches = $derived(detail.patches.filter((p) => p.runId === runId));
// A patch of this run held for its git hook files waits on a person: the Actions tab says so.
const heldPatches = $derived(runPatches.some(isHeld));
// Any patch of the task held so: the page says so at the top, as a run that has ended (or an
// earlier run) leaves its notice far up the transcript.
const taskHeld = $derived(detail.patches.filter(isHeld));

/** Opens the details pane on the run's actions, where a held patch of this run waits. */
function showActions() {
  runPaneTab.set("actions");
  if (!detailsPane.shown) detailsPane.toggle();
}
// The environment builds this run's patches asked for — a patch that changed `.ryph/` is built
// on its branch, and the result is posted to the run (it is in the transcript as a platform
// message); this is the same result, where it can be read at a glance and its log opened.
const runBuilds = $derived(detail.environmentBuilds.filter((b) => b.runId === runId));
// The change request whose merge moved a repo: a task on a pull request moves onto the branch
// it merged into, and stops naming it, and this keeps it on screen. A run's own pull request
// merged into the base it started from moved nothing, and shows nothing here. Only the default
// line's (`work`) merge moves the repo; another line's moves that line alone.
function landedIn(repo: { connectedRepoId: string | null; path: string }) {
  const landing = task.landings[repo.path]?.work;
  return landing !== undefined && repo.connectedRepoId !== null &&
      landing.connectedRepoId === repo.connectedRepoId &&
      landing.moved
    ? landing
    : null;
}
// Where a re-run of a single-repo task starts once something merged: the branch the repo
// stands on now, which the button says.
const rerunOn = $derived(
  task.targetChangeRequest === null && task.repos.length === 1 &&
    task.workspaceId === null && landedIn(task.repos[0]) !== null
    ? branchName(task.repos[0].ref)
    : null,
);
// The check suites this run asked for, and the ones on its patches' heads. Newest first: the
// latest verdict is the one a reader came for.
const runSuites = $derived(
  suitesForRun(detail.checkSuites, runId, new Set(runPatches.map((p) => p.id))).toReversed(),
);
// A suite runs on after the run that asked for it may have ended, so its verdict is polled for
// on its own while any is still going.
const suitesLive = $derived(runSuites.some((suite) => !isSuiteSettled(suite.state)));
// The transcript's checks tool calls show these, live, rather than their replies alone. The
// transcript is the latest run's, so its calls are that run's requests.
setCheckSuitesContext(() => ({ suites: detail.checkSuites, runId }));
setPatchesContext(() => detail.patches, () => refresh.now());
// And its skills, so a read of one shows as the skill being loaded.
const skillsView = $derived(run?.skills ? runSkillsView(run.skills, run.events) : null);
setRunSkillsContext(() => skillsView);
const toldPatches = $derived(
  new Set(
    (run?.messages ?? []).flatMap((m) =>
      m.payload?.kind === "environment" ? [m.payload.patchId] : []
    ),
  ),
);

// ---- The environment: what the run started on, or the build it is waiting for ----
// A run whose environment is still being built sits in provisioning, and nothing about that
// reaches the transcript's stream — the build is not the run. So while it waits, the page re-runs
// its load to see the wait end (see `refreshCadence`), and follows the build's progress on its own.
const environmentWait = $derived(run?.environmentWait ?? null);
const waitingOn = $derived(environmentWait?.environmentId ?? null);
const buildProgress = new BuildProgress(fetch);
$effect(() => buildProgress.follow(waitingOn));

// A run's own span, not the task's: the two differ by however long the task waited to be picked
// up. Only for a settled run — a live one would need a ticking clock to stay honest, and its
// state badge already says it is still going.
const elapsedMs = $derived(
  run === null || !terminal
    ? null
    : new Date(run.updatedAt).getTime() - new Date(run.createdAt).getTime(),
);
// The wall clock counts from launch, not from creation — a run can wait a long time for its
// environment to build before it ever starts spending its clock. Measuring the capped display
// from `createdAt` would show a run stopped at its cap as having overrun it. Clamped at 0: a run
// that fails while booting can have its result recorded before `launchedAt` is stamped.
const elapsedSinceLaunchMs = $derived(
  run === null || !terminal ? null : Math.max(
    0,
    new Date(run.updatedAt).getTime() - new Date(run.launchedAt ?? run.createdAt).getTime(),
  ),
);
const runCost = $derived(usage.usage?.totals.cost.total ?? null);
// The run's caps, as they were frozen on it; each is null on an uncapped run.
const spendCap = $derived(run?.limits?.spendUsd ?? null);
const wallClockCap = $derived(run?.limits?.wallClockMs ?? null);
/** The limit that ended the run, as its trail recorded it; null when none did. */
const limitReached = $derived(
  run?.events.findLast((e) => e.kind === "limit-reached")?.detail ?? null,
);
// The run's history: pages, not one array, fed by the live tail and by whatever the reader scrolls
// back to.
//
// ONE PER RUN, because this component outlives a run: the layout renders `{@render children()}`
// unkeyed, so SvelteKit reuses it across `/tasks/A` → `/tasks/B`, and a retry navigates the same
// way. A single instance re-pointed at the new run put B's rows under the transcript that was still
// drawing A — the virtualiser was holding A's row count, read past the end of a shorter list and
// threw inside a flush, which stops the whole page rendering. A new run is a new object instead,
// and nothing of A's can reach B.
//
// Keyed on the run id alone: `data` is a fresh object on every poll, and minting a history from it
// would throw away everything the reader had scrolled back to at the next one.
const history = $derived.by(() => {
  const id = runId;
  // The constructor reads nothing reactive, and nothing it touches belongs in this derivation.
  // The grant is handed over as a getter: every load re-mints it with a fresh expiry, and a
  // page left open past the grant's ten minutes still has to page the transcript back.
  return untrack(() => new RunHistory(id, fetch, () => historyGrant));
});

// An ordinary effect, deliberately: the transcript below mounts on an empty list and is handed the
// window a beat later, which is exactly how a cold load of this page arrives. One path into the
// transcript, and it is the one the window placement was measured against. What makes another run
// safe is the instance above, not this timing.
//
// Every later load re-runs on the SAME instance, and `seed` is what makes that a
// refresh of the tail rather than a reset of everything the reader has scrolled to. Most later
// loads do not read the history at all: the page says what it holds (below), and the load only
// reads what nothing else is delivering.
$effect(() => {
  const held = history;
  const window = data.history;
  const older = data.olderHistory;
  untrack(() => held.seed(window));
  // Every middle read can fill gaps, even after another poll has seeded a newer tail.
  // The history instance, rather than the load, owns this work; navigation replaces it.
  void older?.then((window) => {
    if (history === held) held.seed(window);
  });
});

// The other half of the transcript: what the orchestrator recorded, what was said to the run, and
// how it ended. It arrives whole with the task detail, so this is what the poller actually
// refreshes — and it lands with the seed above, in the same flush, so the list the transcript places
// its window on already ends with the result row, or with the live one.
$effect(() => {
  const held = history;
  const lifecycle = run?.events ?? [];
  const messages = run?.messages ?? [];
  const result = run?.result ?? null;
  const egressNote = run?.egressNote ?? null;
  const live = run !== null && !terminal;
  untrack(() => held.setDetail({ lifecycle, messages, result, egressNote, live }));
});

// Live tail while the run is going: SSE through the proxy, with reloading as the fallback when
// the stream will not hold (`tail.lost`). The historian closes the stream once the run concludes,
// and `done` is what flips this page out of live mode — reloading then picks up the final state.
const tail = new RunTail();
$effect(() => {
  const id = runId;
  const held = history; // the run's own history: the stream must never feed another run's
  if (id === null || terminal) return;
  // The grant is read once, untracked: every load re-mints it, and a stream that reopened on
  // each new signature would replay its overlap on every poll. A stream that outlives the grant
  // it opened with drops into the reload fallback, like any other lost stream.
  return tail.connect(id, held, untrack(() => historyGrant), { behind: reload, done: reload });
});

// What the page holds of the run, for the load to read around: a seeded history needs only what
// came after it read, and a bill on its own clock needs no read from the load.
$effect(() =>
  hold(() =>
    runId === null ? null : {
      runId,
      seeded: history.seeded,
      lastSeq: history.lastSeq,
      billing: bill.polls(runId),
    }
  )
);

// ---- The run's browser: watched live, in the details pane ----
// The tab is live on a run that was given a browser. A browser call in the loaded history says so
// too, for a control plane that does not report the grant yet. The stream is held open only while
// the tab is on screen.
//
// `?browser=mock` (dev only) shows a pretend browser on any run, for looking at the pane without a
// sidecar behind it; the fixture is never part of a production build.
const ACTION_TOOLS = new Set([
  "submit_patch",
  "run_checks",
  "create_issue",
  "close_issue",
  "add_comment",
  "add_labels",
  "submit_review",
]);

// Everything the pane reads off the transcript, in one walk of it: the transcript grows by a row
// at a time on a live run, and four walks of every row per event added up on a long one. A call
// is read once — the row keeps its call object until the call changes — and kept by that object.
type ReadCall = {
  browser: TranscriptAction | null;
  memory: MemoryCall | null;
  forge: ForgeCall | null;
  action: boolean;
  /** The background command this call started; null for any call that started none. */
  command: string | null;
  /** A `background_stop` that has answered. */
  stop: boolean;
  /** An `expose_port` call, answered or not. */
  preview: boolean;
};
const readCalls = new WeakMap<ToolCall, ReadCall>();
/** The job a successful `background_run` started. */
function startedJob(call: ToolCall): string | null {
  const background = backgroundCallOf(call);
  return background?.tool === "run" && !call.isError ? background.jobId : null;
}
function readCall(call: ToolCall): ReadCall {
  let read = readCalls.get(call);
  if (read === undefined) {
    const memory = memoryCallOf(call);
    read = {
      browser: call.view.kind === "browser"
        ? {
          seq: call.seq,
          at: Date.parse(call.at),
          tool: call.view.tool,
          ...describeBrowserCall(call.view.tool, call.view.args),
          done: call.done,
          isError: call.isError,
        }
        : null,
      memory: memory?.state === "failed" ? null : memory,
      forge: forgeCallOf(call),
      action: call.done && call.view.kind === "mcp" && ACTION_TOOLS.has(call.view.tool),
      command: startedJob(call),
      stop: call.done && backgroundCallOf(call)?.tool === "stop",
      preview: previewCallOf(call) !== null,
    };
    readCalls.set(call, read);
  }
  return read;
}
const transcriptCalls = $derived.by(() => {
  const browser: TranscriptAction[] = [];
  const memory: MemoryCall[] = [];
  const forge: ForgeCall[] = [];
  const actions: number[] = [];
  const inFlight: number[] = [];
  // The background commands the loaded transcript knows of: the ones it started, and the ones
  // whose end it was told.
  const commandIds: string[] = [];
  let notices = 0;
  let stops = 0;
  let preview = false;
  // A call above a gap in what is loaded cannot still be running, since the run went on past it.
  // It only looks unfinished because its result is in the gap.
  let pastGaps = -1;
  for (const row of history.rows) {
    if (row.kind === "gap") pastGaps = Math.max(pastGaps, row.before);
    if (row.kind === "background") {
      commandIds.push(row.notice.id);
      notices++;
    }
    if (row.kind !== "tool") continue;
    const read = readCall(row.call);
    if (read.browser !== null) browser.push(read.browser);
    if (read.memory !== null) memory.push(read.memory);
    if (read.forge !== null) forge.push(read.forge);
    if (read.command !== null) commandIds.push(read.command);
    if (read.stop) stops++;
    if (read.preview) preview = true;
    if (read.action) actions.push(row.call.seq);
    else if (
      !row.call.done && row.call.seq >= pastGaps && row.call.view.kind === "mcp" &&
      ACTION_TOOLS.has(row.call.view.tool)
    ) {
      inFlight.push(row.call.seq);
    }
  }
  return {
    browser,
    memory,
    forge,
    actions,
    inFlight,
    commands: { ids: new Set(commandIds), notices, stops },
    preview,
  };
});

const browserMock = $derived(dev && page.url.searchParams.get("browser") === "mock");
const browserCalls = $derived(transcriptCalls.browser);
const hasBrowser = $derived(
  runId !== null && (run?.browser === true || browserCalls.length > 0 || browserMock),
);

let mockSource = $state.raw<LiveSource | null>(null);
$effect(() => {
  // `dev` first, so a production build drops the import along with the branch.
  if (!dev || !browserMock) return;
  let cancelled = false;
  void import("$lib/components/browser-pane/mock-source").then((mock) => {
    if (!cancelled) mockSource = mock.createMockBrowser().source;
  });
  return () => {
    cancelled = true;
    mockSource = null;
  };
});

// Keyed on the run alone. The grant is read when the stream (re)opens and the run's end when it
// fails, both untracked: every poll re-mints the grant, and a source minted from it would reopen
// the stream on every poll.
const browserSource = $derived.by((): LiveSource | null => {
  if (browserMock) return mockSource;
  const id = runId;
  if (id === null) return null;
  return historianLiveSource(
    id,
    () => untrack(() => historyGrant),
    () => untrack(() => terminal),
  );
});

// ---- The run's background commands: listed, and watched live, in the details pane ----
// The list is read from here, not with the load, which re-runs over and over on a live run:
// when the tab opens, when the live room says a job started or ended, when the transcript's tail
// shows a new start or end, and once as the run concludes.
let durableCommands = $state.raw<{ runId: string; jobs: BackgroundJob[] } | null>(null);
const commandsLoaded = $derived(durableCommands?.runId === runId);
// Not state: only `refreshCommands` reads them.
let commandsReading = false;
let commandsAgain = false;

async function refreshCommands(): Promise<void> {
  const id = runId;
  if (id === null) return;
  if (commandsReading) {
    commandsAgain = true;
    return;
  }
  commandsReading = true;
  try {
    const jobs = await getRunBackground(fetch, id);
    if (id === runId) durableCommands = { runId: id, jobs };
  } catch {
    // The next cue reads it again; until then the tab keeps what it had.
  } finally {
    commandsReading = false;
    if (commandsAgain) {
      commandsAgain = false;
      void refreshCommands();
    }
  }
}

// One per run, for the reason the history is: this component outlives a run.
const commands = $derived.by(() => {
  runId;
  return untrack(() => new CommandsState());
});
// Keyed on the run alone, as the browser's is: the grant and the run's end are read when the
// stream (re)opens or fails.
const commandsSource = $derived.by(() => {
  const id = runId;
  if (id === null) return null;
  return commandsLiveSource(
    id,
    () => untrack(() => historyGrant),
    () => untrack(() => terminal),
  );
});

// The live room said a job started or ended, or lost lines that may have said so.
$effect(() => {
  if (commands.changes === 0) return;
  untrack(() => void refreshCommands());
});

// A new start, stop or end in the transcript, and the run concluding, which stops every job
// still running. Not state: only the effects read it.
const commandsCues = new CommandsCues();
$effect(() => {
  const current = history;
  const { ids, notices, stops } = transcriptCalls.commands;
  if (!current.seeded) return;
  if (commandsCues.transcript(current, ids.size + notices + stops)) {
    untrack(() => void refreshCommands());
  }
});
$effect(() => {
  const id = runId;
  const over = terminal;
  if (commandsCues.terminal(id, over)) untrack(() => void refreshCommands());
});

// On a run that is over, a job the record still has open ended with it.
const runEndedAt = $derived(terminal && run !== null ? Date.parse(run.updatedAt) : null);
const commandJobs = $derived(
  settleWithRun(
    mergeJobs(commandsLoaded ? durableCommands!.jobs : [], commands.jobs),
    runEndedAt,
  ),
);
const runningCommands = $derived(commandJobs.filter((job) => job.endedAt === null).length);

// The record lags what the runner does (a stop asked for while the tab was shut; an end whose log
// is still uploading), so while anything in it can still move it is read again, until it settles.
// Each read is a new list, which is what asks this again.
const commandsPolling = $derived(
  commandsLoaded && needsPolling(commandJobs, Date.now(), !terminal),
);
$effect(() => {
  if (!commandsPolling) return;
  const poll = setInterval(() => void refreshCommands(), COMMANDS_POLL_MS);
  return () => clearInterval(poll);
});

setBackgroundJobsContext({
  job: (id) => commandJobs.find((job) => job.id === id),
  knows: (id) => transcriptCalls.commands.ids.has(id) || commandJobs.some((job) => job.id === id),
  open: (id) => {
    commands.selected = id;
    runPaneTab.set("commands");
    detailsPane.show();
  },
});

// ---- The run's subagents: listed, and their transcripts drawn, in the details pane ----
// The list is the historian's live feed of the run's lanes while the run is live: every lane when
// it opens, then a lane again whenever it starts, is continued or ends. A run that is over is read
// once instead. What a subagent writes goes into its own lane, never the run's.
// One per run, for the reason the history is: this component outlives a run.
const lanes = $derived.by(() => {
  runId;
  return untrack(() => new LanesState(() => runEndedAt));
});
const lanesLoaded = $derived(lanes.loaded);

async function readLanes(id: string, held: LanesState): Promise<void> {
  try {
    held.replace(await getRunLanes(fetch, id, untrack(() => historyGrant)));
  } catch {
    // The tab keeps what it had; the next look at the run reads it again.
  }
}

// Keyed on the run and whether it is over. The grant is read when the stream opens, untracked:
// every load re-mints it, and a feed reopened on each would say every lane again on every poll.
// Like every live stream on the page, the feed is closed while the browser tab is hidden and
// opened again, saying every lane afresh, when it is shown.
$effect(() => {
  const id = runId;
  const held = lanes; // this run's: the feed must never fill another run's list
  if (id === null) return;
  if (terminal) {
    untrack(() => void readLanes(id, held));
    return;
  }
  let poll: ReturnType<typeof setInterval> | undefined;
  const sub = subscribeRunLanes(id, {
    grant: untrack(() => historyGrant),
    onOpen: () => {
      held.opened();
      // The feed is back: it says every lane, so the fallback below can stop.
      clearInterval(poll);
      poll = undefined;
    },
    onLane: (lane) => held.apply(lane),
    // A feed that will not hold (a lapsed grant, a historian going away) is replaced by reading
    // the list on the beat the page's own fallback keeps, until the run is over or the feed opens
    // again: a subagent left showing Running forever is the thing to avoid.
    onError: () => {
      void readLanes(id, held);
      poll ??= setInterval(() => void readLanes(id, held), 5_000);
    },
  });
  return () => {
    sub.close();
    clearInterval(poll);
  };
});

const subagents = $derived(lanes.subagents);
const runningSubagents = $derived(lanes.running);

/** The subagent the tab shows, per run: null for whichever is newest. */
let subagentPick = $state<{ runId: string | null; id: string | null } | null>(null);
const selectedSubagent = $derived(subagentPick?.runId === runId ? subagentPick.id : null);

setSubagentsContext({
  subagent: (id) => subagents.find((s) => s.id === id),
  open: (id) => {
    subagentPick = { runId, id };
    runPaneTab.set("subagents");
    detailsPane.show();
  },
});

/**
 * An action picked in the pane: its call, in the transcript. A pane in a sheet over the transcript
 * shuts first, so the call is not scrolled to behind it.
 */
function showCall(seq: number, docked: boolean) {
  if (!docked) detailsPane.close();
  if (transcript?.scrollToSeq(seq) === false) {
    toast("That part of the run is not loaded. Scroll up in the transcript to load it.");
  }
}

// ---- The details pane: everything about the run that is not the transcript ----
/** A fact in the details record: short ones on one line, long ones under their label. */
const factRow = "flex items-baseline justify-between gap-4 px-3 py-2";
const factStack = "flex flex-col gap-1 px-3 py-2.5";

// Which tab it shows: the one the reader last opened, on this task or another. A run without a
// browser shows Actions in place of that tab, and keeps the choice for the next run that has one.
const shownPaneTab = $derived(
  runPaneTab.current === "browser" && !hasBrowser ? "actions" : runPaneTab.current,
);

/**
 * The tab strip scrolls sideways in a narrow pane; whichever tab is open is brought into view, past
 * the fade at that end, when it opens. Re-run by the attachment whenever the open tab changes.
 */
function keepOpenTabInView(strip: HTMLElement) {
  shownPaneTab;
  const open = strip.querySelector<HTMLElement>("[data-slot=tabs-trigger][data-state=active]");
  if (open === null) return;
  const FADE = 24;
  const tab = open.getBoundingClientRect();
  const box = strip.getBoundingClientRect();
  const by = tab.left < box.left + FADE
    ? tab.left - box.left - FADE
    : tab.right > box.right - FADE
    ? tab.right - box.right + FADE
    : 0;
  if (by === 0) return;
  const smooth = !globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
  strip.scrollBy({ left: by, behavior: smooth ? "smooth" : "auto" });
}

// The phone's bar carries the run's state and actions; see `barControls`.
$effect(() => {
  pageHeader.controls = barControls;
  return () => {
    pageHeader.controls = null;
  };
});

// Handed to the layout, which draws the pane beside the panel; taken back on the way out.
$effect(() => {
  detailsPane.content = paneContent;
  return () => {
    detailsPane.content = null;
  };
});

// ---- The start of a run: queued, booting, cloning, preparing, setting up ----
// None of that reaches the stream above — it is the orchestrator's lifecycle trail, and it arrives
// with the load — and nothing else re-runs the load until the run is running. The
// task list beside this page already follows it live, though: its stream rewrites this task's row
// as the run's state and phase move. So the page watches that row and re-reads itself when the row
// moves, which is the badge and the transcript's lifecycle rows following along in real time.
const taskList = getTaskListContext();
const listed = $derived(taskList.rows.find((row) => row.id === task.id) ?? null);
// The title is part of the move too: the background model names a task after its first message
// lands, and the stream rewrites the row when it does, so the headline follows without waiting
// for the next poll.
const listedMove = $derived(
  listed === null ? null : `${listed.state}/${listed.phase ?? ""}/${listed.title ?? ""}`,
);
// Not state: only the effect reads it, and it is the row as this page last acted on it.
let seenMove: { taskId: string; move: string | null } | null = null;
$effect(() => {
  const taskId = task.id;
  const move = listedMove;
  untrack(() => {
    const before = seenMove;
    seenMove = { taskId, move };
    // The first look at a row is what the load already read; only a move after it is news. A
    // row that only differs from the detail — the two are read at different moments — is not a
    // reason to re-read, or a disagreement between them would re-read forever.
    if (before === null || before.taskId !== taskId || move === null || before.move === move) {
      return;
    }
    reload();
  });
});

// The row is not always there to watch: a task deeper than the pages the list has read, or a list
// whose stream is down. While the run is still getting going — or has not been minted at all —
// the page then asks again on its own, as it does for a pending build. A start is a minute or
// two; this stops the moment the run is running, and the stream above takes over.
const starting = $derived(
  run === null ? !TERMINAL_RUN_STATES.some((s) => s === listed?.state) : run.state === "starting",
);

/**
 * Who a message is from, as the row names it. A `user` message is "You" only when it really is
 * yours: during a response several people speak into one run, and labelling every one of them
 * "You" showed an operator their colleague's instruction as their own. Anyone else goes by the
 * name the control plane resolved when it read the run; one no longer a member has none, and
 * one it could not look up goes by a neutral "A person" rather than being called a former member.
 */
function messageLabel(message: RunMessage): string {
  switch (message.sender.kind) {
    case "user":
      if (message.sender.userId === "break-glass") return "Operator";
      if (message.sender.userId === data.user?.id) return "You";
      if (message.sender.name === undefined) return "A person";
      return message.sender.name ?? "A former member";
    case "chat":
      return `Chat: ${message.sender.name}`;
    case "automation":
      return "Alert";
    case "forge":
      return `@${message.sender.login} on ${
        threadLabel(
          message.sender.provider ?? providerOfRepoRef(message.sender.repoRef),
          null,
          message.sender.thread,
        )
      }`;
    case "platform":
      return "Platform";
  }
}

// The run has settled and is waiting: nothing streams, the last word was the agent's, and
// the run is still alive. Best effort — the page cannot see pi's queue, only its transcript.
const waitingForInput = $derived(
  run !== null && !terminal && run.phase === "running" &&
    history.lastSpoken?.kind === "assistant",
);

// What the transcript's live row says the agent is doing. Only the `running` phase has an agent in
// it: before that the run is provisioning, waiting for its environment, cloning or setting up, and
// after it the runner is finalizing. Neither is the agent working, and the row used to say it was.
// The phase is a gauge this page only sees on a re-load, though, and a run whose list row is not
// streaming is not re-loaded once it is running; an agent that has said something is started
// whatever the stale phase says, so that run does not sit "pending" while it works.
const agentStarted = $derived(
  run?.phase === "running" || (run?.phase !== "finalizing" && history.lastSpoken !== null),
);
const activity = $derived(!agentStarted ? "pending" : waitingForInput ? "idle" : "working");

// ---- The message box: say something to the running agent ----
let transcript = $state<RunTranscript>();

async function sendMessage(text: string, attachmentIds: string[]) {
  if (runId === null) return;
  transcript?.follow();
  await postRunMessage(fetch, runId, text, attachmentIds);
  await refresh.now();
}

// ---- The first message: a task started without instructions asks for them ----
// The page asks in place of the transcript, with the box in the middle of it; what is sent is the
// task's instructions and the run's first turn. Then the box moves down to where it always sits,
// and the transcript takes over.
// This component outlives a task (see the transcript's note below), so what it remembers about
// a first message is remembered by task id: a send still settling on one task says nothing about
// the next one opened.
/** The task whose first message this page is sending right now. */
let promptSendingFor = $state<string | null>(null);
/** The task whose first message this page sent; its next read will say so too. */
let promptSentFor = $state<string | null>(null);
const asking = $derived(
  asksForPrompt({
    awaitingPrompt: awaitsPrompt(task),
    sending: promptSendingFor === task.id,
    sent: promptSentFor === task.id,
  }),
);
const readiness = $derived(promptReadiness(run));

/** The run stopped before the first message, or an image for it, reached it: the box stays, with
 * the draft, and the next read turns it into the way to start again. */
function stoppedBeforePrompt(): string {
  reloadNow();
  return ENDED_BEFORE_PROMPT;
}

async function sendPrompt(text: string, attachmentIds: string[]) {
  if (runId === null) return;
  const taskId = task.id;
  promptSendingFor = taskId;
  try {
    await postRunMessage(fetch, runId, text, attachmentIds);
  } catch (e) {
    if (promptSendingFor === taskId) promptSendingFor = null;
    if (refusedAsEnded(e)) throw new Error(stoppedBeforePrompt());
    throw e;
  }
}

/** An image for the first message refused because the run ended: said as a send would say it,
 * once however many images were on their way. */
function promptUploadRefused(e: unknown): string | null {
  if (!refusedAsEnded(e)) return null;
  toast.error(ENDED_BEFORE_PROMPT, { id: ENDED_BEFORE_PROMPT });
  return stoppedBeforePrompt();
}

// A task that stopped before it got its first message keeps the box and what is in it, and
// pressing send starts it again: a re-run waiting for its first message, opened with the draft
// and its images handed over. The person sends from there. Nothing is kept here between tries.
const startingAgain = new StartAgain(
  () => createTask(fetch, rerunInput({})),
  (taskId) => goto(`/tasks/${taskId}`),
);

function sendRestart(text: string, _attachmentIds: string[], files: File[]) {
  return startingAgain.start({ text, files });
}

// The draft a task started again brought with it, taken the first time this page asks for the
// new task's first message. Not state: only `arrival` reads it, to take the handoff once per task
// however often it re-evaluates.
let arrived: { taskId: string; carried: Carried | null } | null = null;
const arrival = $derived.by(() => {
  if (!asking) return null;
  const taskId = task.id;
  if (arrived?.taskId !== taskId) arrived = { taskId, carried: takeHandoff(taskId) };
  return arrived.carried;
});

/**
 * The box moving from the middle of the page to the bottom, drawn as a stand-in: the box that
 * asked goes away with the question, the docked one is laid out where it will rest but hidden,
 * and this outline travels between the two. Two real boxes, so nothing in either has to be
 * stretched, and the stand-in is fixed to the window, so the page lays out once, finished.
 */
type Flight = { from: ComposerBox; to: ComposerBox | null };
let flight = $state<Flight | null>(null);
let dockComposer = $state<RunComposer>();

async function promptSent(from: ComposerBox | null) {
  const taskId = promptSendingFor;
  promptSendingFor = null;
  if (taskId === null) return;
  promptSentFor = taskId;
  reloadNow();
  // Sent from a task no longer on screen: nothing to fly.
  if (from !== null && taskId === task.id) await flyDown(from);
}

/** Flies a stand-in for the box from where it was to where the docked one now rests. */
async function flyDown(from: ComposerBox) {
  const taskId = task.id;
  if (prefersReducedMotion.current) return;
  flight = { from, to: null };
  await tick();
  const to = dockComposer?.boxShape() ?? null;
  // Gone already (another task opened, or the run ended under it): nothing to land on.
  if (to === null || task.id !== taskId) {
    flight = null;
    return;
  }
  flight = { from, to };
}

const FLIGHT_MS = 420;

function flyBox(trip: Flight): Attachment<HTMLElement> {
  return (el) => {
    const to = trip.to;
    if (to === null) return;
    const at = (box: ComposerBox) => ({
      left: `${box.rect.left}px`,
      top: `${box.rect.top}px`,
      width: `${box.rect.width}px`,
      height: `${box.rect.height}px`,
      borderRadius: box.radius,
    });
    const animation = el.animate([at(trip.from), at(to)], {
      duration: FLIGHT_MS,
      easing: "cubic-bezier(0.32, 0.72, 0, 1)",
      fill: "forwards",
    });
    const land = () => {
      if (flight === trip) flight = null;
    };
    animation.finished.then(land, land);
    return () => animation.cancel();
  };
}

// Following the tail belongs to the transcript now: "the bottom" is the virtualiser's last row,
// and only the virtualiser can scroll to a row it has not mounted yet. `RunTranscript` holds that
// rule, along with everything else that is per-run about the window — where it opens, whether it
// is following, what it has already placed.
//
// All of which is mount-time state, and this component OUTLIVES a run: the layout renders
// `{@render children()}` unkeyed, so SvelteKit reuses it across `/tasks/A` → `/tasks/B`, and a
// re-run navigates the same way. The transcript is therefore keyed on `runId` in the markup below
// — without that key it is never remounted, and task B opened wherever task A had been left, with
// A's follow-the-tail still in force and the virtualiser holding A's scroll offset.

// ---- The forge actions trail: what the run's agent wrote on the forge, as the ledger recorded it ----
// Arrives with the task detail, so the load's poll keeps it current while the run is live.
// A closing note is recorded as a comment of its own beside the close; the close's row shows it.
const forgeActions = $derived.by(() => {
  const actions = run?.forgeActions ?? [];
  const notes = closingNotes(actions, transcriptCalls.forge);
  return notes.size === 0 ? actions : actions.filter((action) => !notes.has(action.id));
});
const forgeScope = $derived(run?.forgeScope ?? null);
// What the agent wrote to memory: memory answers nothing by run, so its calls are the record. Read
// off the transcript like the browser's actions, so they arrive the moment the call does. A call
// memory refused wrote nothing, and is left to the transcript.
const memoryCalls = $derived(transcriptCalls.memory);
const runArtifacts = $derived(artifactsOfRun(detail.artifacts, runId));
// What each forge write said, which the ledger does not keep: read off the agent's calls.
const forgeWrites = $derived(matchForgeWrites(forgeActions, transcriptCalls.forge));
const actionCount = $derived(
  runPatches.length + runSuites.length + forgeActions.length + runBuilds.length +
    memoryCalls.length + runArtifacts.length,
);

// An artifact opened from the actions, shown in their place in the pane. Kept by id and read off
// the latest load, so a new version the agent publishes replaces it; held per run, so another
// run opens on its list. Coming back focuses the artifact's row again.
let openedArtifact = $state<{ runId: string | null; id: string } | null>(null);
let returnedFromArtifact = $state<string | null>(null);
const shownArtifact = $derived(
  openedArtifact !== null && openedArtifact.runId === runId
    ? (runArtifacts.find((a) => a.id === openedArtifact?.id) ?? null)
    : null,
);

// What the pane lists arrives with the load, and nothing streams it: the transcript's tail carries
// the agent's calls, not the patch, suite or forge write a call made. So a call that makes one,
// once it is done, is the cue to read the load again. What the transcript held when it was seeded
// is in the load already, so only two kinds of call count: one newer than anything seeded, and one
// that was still in flight at the seed. Everything else that turns up later is an older page the
// reader scrolled back into, the gap between the run's head and tail included, and reads nothing.
// Each counts once, whatever order the calls finish in.
// Not state: only the effect reads it.
let actionWatch: {
  /** Per history, not per run id: a run left and come back to is read afresh. */
  history: RunHistory;
  seededTo: number;
  inFlight: Set<number>;
  known: Set<number>;
} | null = null;
$effect(() => {
  const { actions, inFlight } = transcriptCalls;
  const current = history;
  if (!current.seeded) return;
  untrack(() => {
    if (actionWatch === null || actionWatch.history !== current) {
      actionWatch = {
        history: current,
        seededTo: current.lastSeq,
        inFlight: new Set(inFlight),
        known: new Set(actions),
      };
      return;
    }
    const watch = actionWatch;
    const fresh = actions.filter((seq) =>
      (seq > watch.seededTo || watch.inFlight.has(seq)) && !watch.known.has(seq)
    );
    if (fresh.length === 0) return;
    for (const seq of fresh) watch.known.add(seq);
    reload();
  });
});

// ...and once made, they move on their own: a patch is submitted and its change request opened,
// its files are checked for git hooks, a build runs. While any of this run's does, the page asks
// again, as it does for a running suite.
const actionsMoving = $derived(
  runPatches.some((p) => isPatchAdvancing(p) || p.hooksPending) ||
    runBuilds.some((build) =>
      build.environment === null
        ? build.note === null
        : build.environment.status === "queued" || build.environment.status === "building"
    ),
);

// How stale the load may get: the shortest of what everything above asks for. The pending build
// and a start nothing else follows are the quickest; a live run's backstop and its grants the
// slowest. A task-list row that streams is what follows a start.
$effect(() => {
  refresh.cadence = refreshCadence({
    hasRun: runId !== null,
    terminal,
    waitingOnBuild: waitingOn !== null,
    streamLost: tail.lost,
    starting: starting && !(taskList.streaming && listed !== null),
    moving: suitesLive || actionsMoving,
  });
});

/** The thread a scope's origin names, the way its own forge writes it. */
const forgeOrigin = $derived.by(() => {
  const origin = forgeScope?.origin;
  if (!origin) return null;
  const repo = forgeScope?.repos.find((r) => r.connectedRepoId === origin.connectedRepoId);
  return repo
    ? repoThreadLabel(repo, origin.kind, origin.ref)
    : `${origin.connectedRepoId} ${origin.ref}`;
});

// ---- Model usage: what the run's model calls cost, as the model proxy metered them ----
// Shown for an agent with a model policy, or for any run that turns out to have spent anyway (the
// agent's policy may have been cleared since). Echo agents never dial a model and get no card.
const hasModel = $derived(
  detail.agent?.modelPolicy != null || (usage.usage?.totals.requests ?? 0) > 0,
);

// The proxy writes a row as each call's response ends, so the bill grows while the run is live.
// One aggregate per model, however long the run — polling it is cheap. `terminal` tears this down,
// so the concluding load — which always reads the bill — has the final word. A poll already in
// flight when the run settles lands after the teardown and is thrown away rather than written over
// that final bill.
$effect(() => {
  const id = runId;
  if (id === null || terminal || !hasModel) return;
  return bill.poll(id, () => usageGrant);
});

// Not waiting after all: the run starts now on what is ready, and the build goes on for the next.
let startingAnyway = $state(false);
async function handleStartAnyway() {
  startingAnyway = true;
  try {
    await startWithoutEnvironment(fetch, task.id);
    await refresh.now();
    toast.success("Starting without waiting for the build");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to start the run");
  } finally {
    startingAnyway = false;
  }
}

// Once the agent said it is done, Finish ends the run on that outcome and Cancel moves into the
// overflow menu. Both shut the sandbox down, so both ask first.
// A finish once asked for stays on the button until the run ends, whatever the agent says after,
// unless someone cancels the run meanwhile.
const finish = $derived(run !== null && !terminal ? finishButton(run) : null);
const finishing = $derived(finish === "finishing");
// The kind outlives the dialog's close, so its words do not change while it fades out.
let confirmOpen = $state(false);
let confirming = $state<"finish" | "cancel">("cancel");
let confirmBusy = $state(false);
// Each opening of the dialog is its own: a request still out from an earlier one (closed while it
// was on its way) never closes or frees the dialog open now.
let confirmToken = 0;
function askFirst(kind: "finish" | "cancel") {
  confirmToken++;
  confirmBusy = false;
  confirming = kind;
  confirmOpen = true;
}

/** The dialog's action: it closes once the request went through, and stays to try again if not. */
async function confirmAction() {
  const token = confirmToken;
  confirmBusy = true;
  try {
    const done = confirming === "finish" ? await handleFinish() : await handleCancel();
    if (done && token === confirmToken) confirmOpen = false;
  } finally {
    if (token === confirmToken) confirmBusy = false;
  }
}

async function handleFinish(): Promise<boolean> {
  try {
    await finishTask(fetch, task.id);
    await refresh.now();
    toast.success("Finishing the run");
    return true;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to finish the run");
    return false;
  }
}

async function handleCancel(): Promise<boolean> {
  // Cancelling before the first prompt hides this task from the list. Leave its page too.
  const returnToList = awaitsPrompt(task) && promptSentFor !== task.id;
  try {
    await cancelTask(fetch, task.id);
    if (returnToList) {
      await goto("/tasks/");
    } else {
      await refresh.now();
    }
    toast.success("Requested cancellation");
    return true;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to cancel task");
    return false;
  }
}

// A re-run is a NEW task with this one's agent, spec and repo — the agent is an editable
// blueprint, so the new run picks up whatever the agent says today, which is the point when
// iterating on an agent's setup. The model and thinking picks are per run and not on the run as this
// page reads it, so they are not carried. A task that worked on a
// change request re-runs on that change request: its head branch is looked up afresh, so the ref
// recorded on the old task is not sent (the two would contradict). Once that change request
// merged, the task sits on the branch it merged into and names no change request, so it re-runs
// there: the merged one cannot be worked on again. It names the task it re-runs, so the images
// that task started with come along with its instructions.
function rerunInput(spec: CreateTaskInput["spec"]): CreateTaskInput {
  const connectedRepoId = task.repos[0].connectedRepoId;
  if (task.workspaceId === null && connectedRepoId === null) throw new Error(LEGACY_RERUN);
  const onto = task.targetChangeRequest === null
    ? {}
    : { targetChangeRequest: task.targetChangeRequest };
  return {
    agentId: task.agentId,
    spec,
    rerunOf: task.id,
    // A workspace task re-runs on the workspace as it stands today; a single repo on the same
    // ref.
    ...(task.workspaceId !== null ? { workspaceId: task.workspaceId, ...onto } : {
      connectedRepoId: connectedRepoId!,
      ...(task.targetChangeRequest === null ? { ref: task.repos[0].ref } : onto),
    }),
  };
}

let rerunning = $state(false);
async function handleRerun() {
  rerunning = true;
  try {
    // A task that never got its instructions re-runs the same way: asking for them.
    const created = await createTask(
      fetch,
      rerunInput({
        ...(task.spec.title === null ? {} : { title: task.spec.title }),
        ...(task.spec.instructions ? { instructions: task.spec.instructions } : {}),
      }),
    );
    toast.success("Re-running as a new task");
    await goto(`/tasks/${created.taskId}`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to re-run task");
  } finally {
    rerunning = false;
  }
}
</script>

<!-- A response is how this task runs: opened by a trigger's fire, joined by the later ones.
     Its fires are in the transcript; this names what it is about and says where it stands.
     Closing one is cancelling the run, so the Cancel above does that. -->
{#snippet responseFact(
  response: { automationId: string; alerts: number; state: string; title: string | null },
)}
  <a
  href="/triggers/{response.automationId}"
  class="inline-flex min-w-0 items-center gap-1 underline-offset-4 hover:underline"
  title={response.title ?? "Opened by a trigger"}
>
    <MessagesSquareIcon class="size-3.5 shrink-0" />
    {#if response.title}<span class="max-w-60 truncate">{response.title}</span>,{/if}
    {response.alerts}
    {response.alerts === 1 ? "fire" : "fires"},
    {response.state === "closed" ? "closed" : response.state === "attended" ? "open, attended" : "open"}
  </a>
{/snippet}

<svelte:head>
  <title>{taskName(task.spec.title)} · Ryph</title>
</svelte:head>

<AlertDialog.Root bind:open={confirmOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>
        {confirming === "finish" ? "Finish this run?" : "Cancel this run?"}
      </AlertDialog.Title>
      <AlertDialog.Description>This will shut down this agent's sandbox.</AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Keep running</AlertDialog.Cancel>
      {#if confirming === "finish"}
        <AlertDialog.Action
          class="bg-success text-success-foreground hover:bg-success/80"
          disabled={confirmBusy}
          onclick={confirmAction}
        >
          {#if confirmBusy}
            <Spinner data-icon="inline-start" />
          {/if}
          Finish
        </AlertDialog.Action>
      {:else}
        <AlertDialog.Action variant="destructive" disabled={confirmBusy} onclick={confirmAction}>
          {#if confirmBusy}
            <Spinner data-icon="inline-start" />
          {/if}
          Cancel run
        </AlertDialog.Action>
      {/if}
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<!-- The run's transcript is the page; everything else about the run is in the details pane, which
     the layout draws on the canvas beside the panel (see `paneContent` below). -->
<TaskColumn>
    <TaskMasthead title={task.spec.title}>
      <!-- Who, then when, the way the pane's rows read, so the open task and its row share a
           grammar; the badges are part of it: how it went. -->
      {#snippet byline()}
        <span class="text-foreground flex min-w-0 items-center gap-2 font-medium">
          <AgentAvatar agentId={task.agentId} size="sm" />
          <span class="truncate">{agentName}</span>
        </span>
        {#if elapsedMs !== null}
          <span class="shrink-0" title="How long the run took">
            {#if wallClockCap === null}
              {formatElapsed(elapsedMs)}
            {:else}
              {formatElapsed(elapsedSinceLaunchMs ?? elapsedMs)} of {formatElapsed(wallClockCap)}
            {/if}
          </span>
        {/if}
        <span class="shrink-0" title={formatDateTime(task.createdAt)}>
          {formatRelativeTime(task.createdAt)}
        </span>
        <span class="flex flex-wrap items-center gap-1.5">
          {#if run}
            <!-- On a phone the bar above shows it, and stays. -->
            <span class="flex max-md:hidden">
              <RunStateBadge state={run.state} phase={run.phase} />
            </span>
          {/if}
            {#if task.purpose === "environment-setup"}
              <Badge variant="outline">Environment setup</Badge>
            {/if}
            {#if run?.attended}
              <Badge variant="secondary" title="A person has spoken to this run">Attended</Badge>
            {/if}
            {#if waitingForInput}
              <Badge
                variant="outline"
                title="The agent has nothing more to do until someone says something"
              >
                Waiting for input
              </Badge>
            {/if}
        </span>
      {/snippet}
      {#snippet actions()}
        {@render runActions(false)}
      {/snippet}
      <!-- Where the run happened, in as few words as place it: the workspace if it has one (which
           is what its repos add up to), otherwise the one repo and what it targets, and past that
           only a count; then what it cost and, for a response's run, the response. Everything else
           about the run is a record, not a headline, and lives in the Details tab. -->
      {#snippet facts()}
        {#if detail.workspace}
          <div class="flex items-center gap-1.5">
            <dt class="text-muted-foreground">Workspace</dt>
            <dd>
              <a href="/workspaces/{detail.workspace.id}" class="underline-offset-4 hover:underline">
                {detail.workspace.name}
              </a>
            </dd>
          </div>
        {:else if task.repos.length === 1}
          {@const repo = task.repos[0]}
          <div class="flex min-w-0 items-center gap-1.5">
            <dt class="text-muted-foreground">Repo</dt>
            <dd class="flex min-w-0 items-center gap-1.5">
              <span class="max-w-72 truncate font-mono" title="{repo.name} at {repo.ref}">
                {repo.path}@{branchName(repo.ref)}
              </span>
              {#if task.targetChangeRequest}
                <span class="text-muted-foreground">onto</span>
                <ThreadLabel
                  thread={task.targetChangeRequest.thread}
                  provider={repo.provider ?? undefined}
                />
              {:else if landedIn(repo)}
                <ThreadLabel thread={landedIn(repo)!.thread} provider={repo.provider ?? undefined} />
                <span class="text-muted-foreground">merged</span>
              {/if}
            </dd>
          </div>
        {:else if task.repos.length > 1}
          <div class="flex items-center gap-1.5">
            <dt class="text-muted-foreground">Repos</dt>
            <dd>{task.repos.length}</dd>
          </div>
        {/if}
        {#if runCost !== null}
          <div class="flex items-center gap-1.5" title="Estimated at list price">
            <dt class="text-muted-foreground">Cost</dt>
            <dd>{formatUsd(runCost)}{spendCap === null ? "" : ` of ${formatUsd(spendCap)}`}</dd>
          </div>
        {/if}
        {#if detail.response}
          <div class="flex items-center gap-1.5">
            <dt class="text-muted-foreground">Response</dt>
            <dd>
              {@render responseFact(detail.response)}
            </dd>
          </div>
        {/if}
      {/snippet}
    </TaskMasthead>

    {#if taskHeld.length > 0}
      <Alert.Root variant="destructive">
        <TriangleAlertIcon />
        <Alert.Title>{HOOK_BANNER_TITLE}</Alert.Title>
        <Alert.Description class="[&_a]:no-underline">
          <ul class="flex flex-col gap-2">
            {#each taskHeld as patch (patch.id)}
              <li class="text-foreground flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span class="min-w-0 flex-1">
                  {patch.title ?? `Patch to ${patch.path}/`} edits git hooks.
                </span>
                <span class="flex items-center gap-1.5">
                  {#if patch.runId === runId}
                    <Button variant="outline" size="sm" onclick={showActions}>
                      Show details
                    </Button>
                  {/if}
                  <Button variant="outline" size="sm" href="/patches/{patch.id}">
                    <FileDiffIcon data-icon="inline-start" />
                    View the diff
                  </Button>
                </span>
              </li>
            {/each}
          </ul>
        </Alert.Description>
      </Alert.Root>
    {/if}

    <!-- A run waiting for its environment: the build it waits on, inline, because until it is
         ready that build IS what the run is doing. It is cancellable like any run, from the
         masthead. -->
    {#if environmentWait && !terminal}
      <EnvironmentWait
        environmentId={environmentWait.environmentId}
        build={buildProgress.build}
        now={buildProgress.now}
        starting={startingAnyway}
        onstart={handleStartAnyway}
      />
    {/if}

    <!-- Fills what the column leaves, so that the message box at its end rests on the bottom of
         the window however short the run is: the transcript grows to push it there. -->
    <div class="flex flex-1 flex-col gap-6">
      {#if asking}
        {@render promptStage()}
      {:else}
        <!-- Fades in when it takes over from the question; a page that opens on it just shows it. -->
        <div
          class="flex flex-1 flex-col gap-6"
          in:fade={{ duration: prefersReducedMotion.current ? 0 : 240, delay: 60 }}
        >
            {#if run !== null && !history.seeded}
              <!-- The run is there and its history is not: the read for the end of the run did not
                   answer, so there is nothing to draw and nothing to be honest about except that. An
                   inline state rather than the error page, because everything else on this page — the
                   run's state, its patches, its bill — arrived and is worth looking at. The retry is
                   the load again; the poller behind a live run is already doing it. -->
              <Empty.Root class="border border-dashed">
                <Empty.Header>
                  <Empty.Media variant="icon">
                    <TriangleAlertIcon />
                  </Empty.Media>
                  <Empty.Title>Could not load the run's history</Empty.Title>
                  <Empty.Description>
                    {data.history.error ?? "The historian did not answer."}
                  </Empty.Description>
                </Empty.Header>
                <Button variant="outline" size="sm" onclick={reloadNow}>
                  <RefreshCwIcon data-icon="inline-start" />
                  Retry
                </Button>
              </Empty.Root>
            {:else if history.bare}
              <Empty.Root class="border border-dashed">
                <Empty.Header>
                  <Empty.Media variant="icon">
                    <ScrollTextIcon />
                  </Empty.Media>
                  <Empty.Title>Nothing recorded yet</Empty.Title>
                  <Empty.Description>
                    {run && !terminal
                      ? "The run is starting up — its history appears here as it happens."
                      : "This run left no history."}
                  </Empty.Description>
                </Empty.Header>
              </Empty.Root>
            {:else}
              <!-- Keyed on the run: a different run is a different window, opened at ITS end. -->
              {#key runId}
                <RunTranscript
                  bind:this={transcript}
                  {history}
                  {activity}
                  skills={run?.skills ?? null}
                  agentId={task.agentId}
                  {agentName}
                  senderLabel={messageLabel}
                  trailing={showComposer ? composerHeight : 0}
                />
              {/key}
            {/if}
        </div>

        {#if showComposer && runId !== null}
          <!-- The message box: what a person says here lands in the run's inbox, and the agent reads
               it as untrusted text from a named person — it can steer the work in flight, never hand
               in new work.

               Measured, because the transcript above follows the tail to the bottom of the PAGE and
               this is what is under it. Keyed on the run, because the images in it were uploaded
               to that run. Text is restored separately from this person's task draft. -->
          {#key runId}
            <RunComposer
              bind:this={dockComposer}
              draftKey={taskDraftKey(data.user.id, task.id)}
              {runId}
              {agentName}
              onSend={sendMessage}
              contextUsage={detail.agent?.modelPolicy != null || history.contextUsage !== null
                ? history.contextUsage
                : undefined}
              concealed={flight !== null}
              bind:height={composerHeight}
            />
          {/key}
        {/if}
      {/if}
    </div>
</TaskColumn>

<!-- The message box on its way from the middle of the page to the bottom; see `promptSent`. -->
{#if flight}
  <div
  aria-hidden="true"
  class="bg-background border-input pointer-events-none fixed z-30 overflow-hidden border shadow-xs"
  style:left="{flight.from.rect.left}px"
  style:top="{flight.from.rect.top}px"
  style:width="{flight.from.rect.width}px"
  style:height="{flight.from.rect.height}px"
  style:border-radius={flight.from.radius}
  {@attach flyBox(flight)}
>
  <div class="dark:bg-input/30 absolute inset-0"></div>
</div>
{/if}

<!-- The task has no instructions yet: the page asks for them, and says quietly whether the run is
     ready for them. A message can go before it is; the run holds it until then. A run that stopped
     waiting keeps the box and what is in it, and sending starts the task again. -->
{#snippet promptStage()}
  <PromptStage agentId={task.agentId} {agentName}>
    {#if runId !== null}
      <!-- One box either way, so the run stopping under it keeps the draft and its images. -->
      {#key runId}
        <RunComposer
          {runId}
          {agentName}
          variant="prompt"
          draftKey={taskDraftKey(data.user.id, task.id)}
          sendLabel={readiness === "ended" ? "Start again" : "Send"}
          canAddImages={readiness !== "ended"}
          sendsFiles={readiness === "ended"}
          prefill={arrival}
          uploadRefused={promptUploadRefused}
          onSend={readiness === "ended" ? sendRestart : sendPrompt}
          onSent={readiness === "ended" ? undefined : promptSent}
        />
      {/key}
    {/if}
    {#snippet status()}
      {#if readiness === "ended" && legacy}
        <CirclePauseIcon class="size-3.5" />
        {LEGACY_START_AGAIN}
      {:else if readiness === "ended"}
        <CirclePauseIcon class="size-3.5" />
        This task stopped. Send to start it again.
      {:else if arrival !== null}
        <RotateCcwIcon class="size-3.5" />
        Started again. Your message is ready to send.
      {:else if readiness === "ready"}
        <CircleCheckIcon class="size-3.5" />
        Ready
      {:else if readiness === "getting-ready"}
        <Spinner class="size-3.5" />
        Getting ready…
      {/if}
    {/snippet}
  </PromptStage>
{/snippet}

<!-- What can be done about the run: in the masthead, and on a phone in the breadcrumb bar, where
     there is room only for icons. -->
{#snippet runActions(compact: boolean)}
  <!-- The poll behind this page missed. One line, in the muted voice the facts below use, and
       nothing else moves: the run is still on screen, the stream may well still be delivering,
       and the next poll is what takes this away. It used to be SvelteKit's
       error page, over a run that was still going. On a phone, the spinner alone. -->
  {#if connectionLost}
    <span
  class="text-muted-foreground flex items-center gap-1.5 text-xs"
  title="The last update did not arrive. Showing what was last read; retrying."
>
  <Spinner class="size-3.5" />
  <span class={[compact && "sr-only"]}>Connection lost, retrying…</span>
</span>
  {/if}
  {#if finish !== null}
    <Button
  size={compact ? "icon-sm" : "sm"}
  class="bg-success text-success-foreground hover:bg-success/80"
  title={compact ? (finishing ? "Finishing" : "Finish") : undefined}
  disabled={finishing}
  onclick={() => askFirst("finish")}
>
      {#if finishing}
        <Spinner data-icon={compact ? undefined : "inline-start"} />
      {:else}
        <CircleCheckIcon data-icon={compact ? undefined : "inline-start"} />
      {/if}
      <span class={[compact && "sr-only"]}>{finishing ? "Finishing…" : "Finish"}</span>
    </Button>
  {:else if run && !terminal}
    <Button
  variant="destructive"
  size={compact ? "icon-sm" : "sm"}
  title={compact ? "Cancel run" : undefined}
  onclick={() => askFirst("cancel")}
>
  <XIcon data-icon={compact ? undefined : "inline-start"} />
  <span class={[compact && "sr-only"]}>Cancel run</span>
</Button>
  {/if}
  <DropdownMenu.Root>
  <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="ghost" size="icon-sm" aria-label="More run actions">
          <MoreHorizontalIcon />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end">
      <DropdownMenu.Group>
        <DropdownMenu.CheckboxItem bind:checked={history.showDiag}>
          Show diagnostics
        </DropdownMenu.CheckboxItem>
      </DropdownMenu.Group>
      {#if finish !== null}
        <DropdownMenu.Separator />
        <DropdownMenu.Group>
          <DropdownMenu.Item variant="destructive" onclick={() => askFirst("cancel")}>
            <XIcon />
            Cancel run
          </DropdownMenu.Item>
        </DropdownMenu.Group>
      {/if}
    </DropdownMenu.Content>
</DropdownMenu.Root>
  <!-- The details pane's switch. Shut, it asks to be opened in words; open, the pane speaks for
       itself and the switch shrinks to an icon that shuts it. Icon-only on the phone's bar, where
       there is no room for the words. -->
  {@const wordy = !compact && !detailsPane.shown}
  <Button
  variant={wordy ? "outline" : "ghost"}
  size={wordy ? "sm" : "icon-sm"}
  aria-expanded={detailsPane.shown}
  aria-label={wordy ? undefined : detailsPane.shown ? "Hide details" : "View details"}
  title={wordy ? undefined : detailsPane.shown ? "Hide details" : "View details"}
  onclick={detailsPane.toggle}
>
    {#if detailsPane.shown}
      <PanelRightCloseIcon />
    {:else}
      <PanelRightOpenIcon data-icon={wordy ? "inline-start" : undefined} />
    {/if}
    {#if wordy}View details{/if}
  </Button>
{/snippet}

<!-- The phone's sticky bar: the masthead scrolls away there, since stuck it took a third of the
     screen, and the bar already names the task. How the run is doing, and what to do about it. -->
{#snippet barControls()}
  <div class="flex items-center gap-1.5 md:hidden">
    {#if run}
      <RunStateBadge state={run.state} phase={run.phase} />
    {/if}
    {@render runActions(true)}
  </div>
{/snippet}

<!-- The details pane: what the run did, its record, what it cost, and its browser. The layout
     draws it on the canvas beside the panel, or as a sheet where there is no room; the page hands
     it this snippet and keeps everything it shows. -->
<!-- A tab's name. In a pane too narrow for every name, only the open tab says it, and the rest are
     their icons (named for a screen reader, and in a tooltip): six names do not fit beside each
     other in a pane of the width it usually has, and a strip that scrolled them out of sight hid
     the very tabs a reader was looking for. -->
{#snippet tabLabel(text: string)}
  <span
  class="sr-only group-data-[state=active]/tab:not-sr-only @[44rem]/strip:not-sr-only"
>
    {text}
  </span>
{/snippet}

{#snippet paneContent({ docked, close }: DetailsPaneContext)}
  <!-- Keyed on the run, like the transcript: this snippet outlives a run, and without the key the
       next task's pane opened at the last one's scroll positions, filter and opened suites. -->
  {#key runId}
  <Tabs.Root
  bind:value={() => shownPaneTab, runPaneTab.set}
  class="flex min-h-0 flex-1 flex-col gap-0"
>
  <!-- Keeps the open tab in view in a narrow pane. -->
  <PaneHeader {docked} {close} strip={keepOpenTabInView}>
    <Tabs.List variant="line" class="justify-start *:shrink-0">
        <Tabs.Trigger value="actions" class="group/tab" title="Actions">
          <ActivityIcon />
          {@render tabLabel("Actions")}
          {#if actionCount > 0}
            <span class="text-muted-foreground tabular-nums">{actionCount}</span>
          {/if}
          {#if heldPatches}
            <span class="bg-destructive size-1.5 rounded-full" title={HOOK_HELD_LABEL}></span>
            <span class="sr-only">{HOOK_HELD_LABEL}</span>
          {/if}
        </Tabs.Trigger>
        {#if hasBrowser}
          <Tabs.Trigger value="browser" class="group/tab" title="Browser">
            <MonitorIcon />
            {@render tabLabel("Browser")}
          </Tabs.Trigger>
        {:else}
          <!-- A disabled button takes no pointer events, so the tooltip hangs on a wrapper. Out of
               the tab order, or a sheet opening would focus it first and pop the tooltip. -->
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                <span {...props} tabindex={-1} class="flex">
                  <Tabs.Trigger value="browser" disabled class="group/tab">
                    <MonitorIcon />
                    {@render tabLabel("Browser")}
                  </Tabs.Trigger>
                </span>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content>This agent has no browser</Tooltip.Content>
          </Tooltip.Root>
        {/if}
        <Tabs.Trigger value="commands" class="group/tab" title="Commands">
          <SquareTerminalIcon />
          {@render tabLabel("Commands")}
          {#if runningCommands > 0}
            <span class="text-muted-foreground tabular-nums">
              {runningCommands}<span class="sr-only"> running</span>
            </span>
          {/if}
        </Tabs.Trigger>
        <Tabs.Trigger value="subagents" class="group/tab" title="Subagents">
          <BotIcon />
          {@render tabLabel("Subagents")}
          {#if runningSubagents > 0}
            <span class="text-muted-foreground tabular-nums">
              {runningSubagents}<span class="sr-only"> running</span>
            </span>
          {/if}
        </Tabs.Trigger>
        <Tabs.Trigger value="details" class="group/tab" title="Details">
          <InfoIcon />
          {@render tabLabel("Details")}
        </Tabs.Trigger>
        <Tabs.Trigger value="usage" class="group/tab" title="Usage">
          <ChartColumnIcon />
          {@render tabLabel("Usage")}
        </Tabs.Trigger>
      </Tabs.List>
  </PaneHeader>

  <Tabs.Content value="details"
    class="scroll-fade-y min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {#if shownPaneTab === "details"}
        {@render runRecord()}
      {/if}
    </Tabs.Content>

  <!-- Each tab is mounted only while it is the one on screen: a tab the pane does not show is
       hidden, not unmounted, and a long run's timeline is a lot to keep rendering out of sight. -->
  <Tabs.Content value="actions" class="flex min-h-0 flex-1 flex-col">
    {#if shownPaneTab === "actions" && shownArtifact !== null}
      <ArtifactPane
        artifact={shownArtifact}
        onback={() => {
          returnedFromArtifact = shownArtifact?.id ?? null;
          openedArtifact = null;
        }}
      />
    {:else if shownPaneTab === "actions"}
    <RunActions
      patches={runPatches}
      suites={runSuites}
      allSuites={detail.checkSuites}
      {forgeActions}
      builds={runBuilds}
      {memoryCalls}
      {forgeWrites}
      target={task.targetChangeRequest ?? null}
      {toldPatches}
      {terminal}
      artifacts={runArtifacts}
      {runId}
      focusArtifact={returnedFromArtifact}
      onfocusedartifact={() => (returnedFromArtifact = null)}
      onopenartifact={(id) => {
        returnedFromArtifact = null;
        openedArtifact = { runId, id };
      }}
    />
    {/if}
  </Tabs.Content>

  <Tabs.Content value="usage"
    class="scroll-fade-y min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {#if shownPaneTab !== "usage"}
        <!-- Out of sight: see above. -->
      {:else if hasModel}
        <RunUsage {usage} {terminal} {elapsedMs} {spendCap} />
      {:else}
        <p class="text-muted-foreground px-4 pt-4 text-sm">This agent does not use a model.</p>
      {/if}
    </Tabs.Content>

  <!-- The browser's pane matters most of all: it holds the live stream open while mounted. -->
  <Tabs.Content value="browser" class="flex min-h-0 flex-1 flex-col">
      {#if shownPaneTab === "browser" && browserSource !== null}
        <BrowserPane
          source={browserSource}
          runEnded={terminal}
          calls={browserCalls}
          header={false}
          onselect={(seq) => showCall(seq, docked)}
        />
      {/if}
    </Tabs.Content>

  <!-- Holds the commands' live stream open while mounted, as the browser's does. -->
  <Tabs.Content value="commands" class="flex min-h-0 flex-1 flex-col">
      {#if shownPaneTab === "commands" && runId !== null}
        <CommandsPane
          state={commands}
          previews={previews.previews}
          previewsAvailable={previews.status === "ready"}
          previewHref={(preview) => previews.href(preview)}
          jobs={commandJobs}
          source={commandsSource}
          {runId}
          loaded={commandsLoaded}
          refresh={refreshCommands}
          runEnded={terminal}
        />
      {/if}
    </Tabs.Content>

  <!-- Holds the shown subagent's live stream open while mounted. -->
  <Tabs.Content value="subagents" class="flex min-h-0 flex-1 flex-col">
      {#if shownPaneTab === "subagents" && runId !== null}
        {@const id = runId}
        <SubagentsPane
          {subagents}
          bind:selected={() => selectedSubagent, (picked) => (subagentPick = { runId: id, id: picked })}
          loaded={lanesLoaded}
          runId={id}
          grant={() => untrack(() => historyGrant)}
          root={() => history.root}
          runEnded={terminal}
          agentId={task.agentId}
          parentName={agentName}
          showDiag={history.showDiag}
        />
      {/if}
    </Tabs.Content>
</Tabs.Root>
  {/key}
{/snippet}

<!-- The run's record: every fact the masthead used to carry and a few it never had room for —
     exact times, full refs, the image itself. Grouped the way a reader looks things up: the three
     numbers first, then the run, the code it worked on, and what it was taught. A short fact sits on
     one line, label left and value right; a long one gets the card's full width under its label. -->
{#snippet runRecord()}
  {@const limits = run?.limits
    ? [
      run.limits.wallClockMs === null ? null : `${formatElapsed(run.limits.wallClockMs)} wall clock`,
      run.limits.spendUsd === null ? null : `${formatUsd(run.limits.spendUsd)} spend`,
      run.limits.callsInFlight === null ? null : `${run.limits.callsInFlight} calls in flight`,
    ].filter((part) => part !== null)
    : null}
  <div class="flex flex-col gap-6 px-4 pt-4 pb-6 text-sm">
    <!-- At a glance: who, how long, how much. -->
    <section class="bg-background flex flex-col rounded-md border">
      <div class="flex items-center gap-2.5 border-b px-3 py-2.5">
        <AgentAvatar agentId={task.agentId} size="sm" />
        <span class="min-w-0 flex-1 truncate font-medium">{agentName}</span>
        <time datetime={task.createdAt} title={formatDateTime(task.createdAt)}
          class="text-muted-foreground shrink-0 text-xs">
          {formatRelativeTime(task.createdAt)}
        </time>
      </div>
      <dl class="grid grid-cols-2 divide-x">
        <div class="flex flex-col gap-0.5 px-3 py-2.5">
          <dt class="text-muted-foreground text-xs">Took</dt>
          <dd class="text-base font-medium tabular-nums">
            {elapsedMs === null ? "—" : formatElapsed(elapsedMs)}
          </dd>
        </div>
        <div class="flex flex-col gap-0.5 px-3 py-2.5">
          <dt class="text-muted-foreground text-xs">Cost</dt>
          <dd class="text-base font-medium tabular-nums" title="Estimated at list price">
            {runCost === null ? "—" : formatUsd(runCost)}
          </dd>
        </div>
      </dl>
    </section>

    <section class="flex flex-col gap-2">
      <h3 class="text-muted-foreground px-1 text-xs font-medium">Run</h3>
      <dl class="bg-background flex flex-col divide-y rounded-md border">
        {@render fact("Created", formatDateTime(task.createdAt))}
        {#if run}
          {@render fact("Started", formatDateTime(run.createdAt))}
          {#if run.workItem?.runSize}
            {@const size = run.workItem.runSize}
            <div class={factRow}>
              <dt class="text-muted-foreground shrink-0">Size</dt>
              <dd
                class="min-w-0 truncate text-right"
                title={`${sizeSummary(size)}. Host and Docker limits still apply.`}>
                {runSizeLabel(size)}
              </dd>
            </div>
          {/if}
        {/if}
        {#if task.purpose === "environment-setup"}
          {@render fact("Purpose", "Environment setup")}
        {/if}
        {#if detail.workspace}
          <div class={factRow}>
            <dt class="text-muted-foreground shrink-0">Workspace</dt>
            <dd class="min-w-0 truncate text-right">
              <a href="/workspaces/{detail.workspace.id}" class="underline-offset-4 hover:underline">
                {detail.workspace.name}
              </a>
            </dd>
          </div>
        {/if}
        {#if task.origin === "chat"}
          <!-- Started by a mention of the bot in a command room: the conversation it answers is
               the chat thread, and it acts for the room's owner, not for whoever asked. -->
          <div class={factRow}>
            <dt class="text-muted-foreground shrink-0">Started by</dt>
            <dd class="min-w-0 text-right">
              <a
                href="/chat"
                class="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                title="Started by a mention in a command room; it runs as the room's owner"
              >
                <MessagesSquareIcon class="size-3.5" />
                A chat mention
              </a>
            </dd>
          </div>
        {:else if task.origin === "token"}
          <!-- Started by a script or an agent holding the requester's API token: it acted for
               them, with the capabilities the token was minted with. -->
          <div class={factRow}>
            <dt class="text-muted-foreground shrink-0">Started by</dt>
            <dd class="min-w-0 text-right">
              <a
                href="/account"
                class="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                title="Started through an API token; it runs as the token's owner"
              >
                <KeyRoundIcon class="size-3.5" />
                An API token
              </a>
            </dd>
          </div>
        {/if}
        {#if detail.response}
          <div class={factRow}>
            <dt class="text-muted-foreground shrink-0">Response</dt>
            <dd class="min-w-0 text-right">{@render responseFact(detail.response)}</dd>
          </div>
        {/if}
        {#if limits !== null}
          <div class={factStack}>
            <dt class="text-muted-foreground">Limits</dt>
            <dd class="flex flex-wrap items-center gap-1">
              {#each limits as limit (limit)}
                <Badge variant="secondary">{limit}</Badge>
              {:else}
                <span>None</span>
              {/each}
            </dd>
            {#if limitReached}
              <dd class="text-destructive text-xs">Stopped at {limitReached}</dd>
            {/if}
          </div>
        {/if}
        {#if run && taskImages.length > 0}
          <!-- What the task arrived with from its thread or chat, which the transcript has no row
               for: the agent was handed these beside its instructions. -->
          <div class={factStack}>
            <dt class="text-muted-foreground">Images</dt>
            <dd><AttachmentImages runId={run.id} attachments={taskImages} /></dd>
          </div>
        {/if}
      </dl>
    </section>

    {#if task.repos.length > 0 || run?.environment || forgeScope}
      <section class="flex flex-col gap-2">
        <h3 class="text-muted-foreground px-1 text-xs font-medium">Code</h3>
        <dl class="bg-background flex flex-col divide-y rounded-md border">
          {#each task.repos as repo (repo.path)}
            <div class={factStack}>
              <dt class="text-muted-foreground flex items-baseline justify-between gap-2">
                <span>Repo</span>
                {#if task.targetChangeRequest &&
                  task.targetChangeRequest.connectedRepoId === repo.connectedRepoId}
                  <span class="flex items-center gap-1 text-xs">
                    onto <ThreadLabel
                      thread={task.targetChangeRequest.thread}
                      provider={repo.provider ?? undefined}
                    />
                  </span>
                {:else if landedIn(repo)}
                  <span class="flex items-center gap-1 text-xs">
                    <ThreadLabel thread={landedIn(repo)!.thread} provider={repo.provider ?? undefined} />
                    merged
                  </span>
                {/if}
              </dt>
              <dd class="truncate font-medium" title={repo.name}>{repo.name}</dd>
              <dd class="text-muted-foreground font-mono text-xs break-all">
                {repo.path}@{branchName(repo.ref)}
              </dd>
            </div>
          {/each}
          {#if run?.environment}
            {@const environment = run.environment}
            <div class={factStack}>
              <dt class="text-muted-foreground">Environment</dt>
              <dd>
                {runEnvironmentLabel(environment)}
                {#if environment.builtAt && environment.id !== DEFAULT_ENVIRONMENT_ID}
                  <span class="text-muted-foreground">
                    · built {formatRelativeTime(environment.builtAt)}
                  </span>
                {/if}
              </dd>
              <dd
                class="bg-muted text-muted-foreground mt-1 rounded-sm px-2 py-1.5 font-mono text-[0.6875rem] leading-relaxed break-all"
              >
                {environment.image}
              </dd>
            </div>
          {/if}
          {#if forgeScope}
            <!-- What the agent may write on: as the platform's GitHub App or Radicle key, signed
                 with its name and a link back here. What it did write is under Actions. -->
            <div class={factStack}>
              <dt class="text-muted-foreground">Forge access</dt>
              {#if forgeScope.repos.length > 0}
                <dd class="flex flex-wrap gap-1">
                  {#each forgeScope.repos as repo (forgeRepoLabel(repo))}
                    <Badge variant="secondary" class="max-w-full truncate">{forgeRepoLabel(repo)}</Badge>
                  {/each}
                </dd>
                {#if forgeOrigin}
                  <dd class="text-muted-foreground text-xs break-words">Started from {forgeOrigin}</dd>
                {/if}
              {:else}
                <dd class="text-muted-foreground">None</dd>
              {/if}
            </div>
          {/if}
        </dl>
      </section>
    {/if}

    {#if run?.skills}
      <section class="flex flex-col gap-2">
        <h3 class="text-muted-foreground px-1 text-xs font-medium">Skills</h3>
        <div class="bg-background rounded-md border px-3 py-2.5 wrap-anywhere">
          <RunSkills
            skills={run.skills}
            events={run.events}
            settled={terminal || run.skillsReportedAt !== null}
          />
        </div>
      </section>
    {/if}

    <!-- A re-run is a new task from this one, so it sits with the record it is made from rather
         than beside what the run is doing. While the run is live, Cancel is the action instead. -->
    {#if (!run || terminal) && legacy}
      <Button variant="outline" size="sm" class="w-full" disabled>
        <RefreshCwIcon data-icon="inline-start" />
        Re-run
      </Button>
      <p class="text-muted-foreground text-xs">{LEGACY_RERUN}</p>
    {:else if !run || terminal}
      <Button variant="outline" size="sm" class="w-full" disabled={rerunning} onclick={handleRerun}>
        {#if rerunning}
          <Spinner data-icon="inline-start" />
        {:else}
          <RefreshCwIcon data-icon="inline-start" />
        {/if}
        {rerunOn === null ? "Re-run" : `Re-run on ${rerunOn}`}
      </Button>
    {/if}
  </div>
{/snippet}

{#snippet fact(label: string, value: string)}
  <div class={factRow}>
  <dt class="text-muted-foreground shrink-0">{label}</dt>
  <dd class="min-w-0 text-right">{value}</dd>
</div>
{/snippet}
