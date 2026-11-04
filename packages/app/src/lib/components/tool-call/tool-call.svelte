<script module lang="ts">
/**
 * Pull the renderer's chunk while nothing else needs the main thread. It is ~780 KB and every row
 * that can draw one waits on the same one, so whichever row is opened first otherwise pays for all
 * of them — that wait is what read as the row hanging before it opened.
 *
 * Module scope, so this is once per page rather than once per row: a timeline has many of these,
 * and they would otherwise each queue their own callback.
 */
let warming = false;
function warmRenderer(): void {
  if (warming) return;
  warming = true;
  const pull = () => void import("@pierre/diffs").catch(() => {});
  // Safari only grew requestIdleCallback recently; a timeout is a fine stand-in for "later".
  if (typeof requestIdleCallback === "function") requestIdleCallback(pull);
  else setTimeout(pull, 1_000);
}

import BookOpenTextIcon from "@lucide/svelte/icons/book-open-text";
import BotIcon from "@lucide/svelte/icons/bot";
import BrainIcon from "@lucide/svelte/icons/brain";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import CircleCheckBigIcon from "@lucide/svelte/icons/circle-check-big";
import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
import CircleDotIcon from "@lucide/svelte/icons/circle-dot";
import CircleStopIcon from "@lucide/svelte/icons/circle-stop";
import CircleXIcon from "@lucide/svelte/icons/circle-x";
import ClockIcon from "@lucide/svelte/icons/clock";
import EyeIcon from "@lucide/svelte/icons/eye";
import FilePlusIcon from "@lucide/svelte/icons/file-plus";
import FlagIcon from "@lucide/svelte/icons/flag";
import FolderOpenIcon from "@lucide/svelte/icons/folder-open";
import GitPullRequestIcon from "@lucide/svelte/icons/git-pull-request";
import GlobeIcon from "@lucide/svelte/icons/globe";
import ListChecksIcon from "@lucide/svelte/icons/list-checks";
import MessageSquareIcon from "@lucide/svelte/icons/message-square";
import PencilIcon from "@lucide/svelte/icons/pencil";
import PlugIcon from "@lucide/svelte/icons/plug";
import ScrollTextIcon from "@lucide/svelte/icons/scroll-text";
import SearchIcon from "@lucide/svelte/icons/search";
import SquareTerminalIcon from "@lucide/svelte/icons/square-terminal";
import TagIcon from "@lucide/svelte/icons/tag";
import TerminalIcon from "@lucide/svelte/icons/terminal";
import WrenchIcon from "@lucide/svelte/icons/wrench";
import type { ToolCall } from "$lib/api/tools";
import type { SkillRead } from "$lib/utils/skills";
import { describeBrowserCall } from "$lib/utils/browser-tools";
import { outcomeCallLabel, type ReportedOutcome, reportedOutcome } from "$lib/utils/outcome-report";
import { browserToolIcon } from "./browser-icons";

// The platform's own tools said the way a person would say them. Every one of these goes through
// the gateway like any other MCP tool, so a transcript otherwise reads as a list of `Called
// propose` — the plumbing rather than what happened.
//
// Keyed on the bare tool name, and the memory server's are scoped to it: `search`, `get` and `doc`
// are names anyone's MCP server might use, and only this one's mean what the label says. The rest
// are distinctive enough to stand alone.
const PLATFORM_TOOLS: Record<
  string,
  { label: string; icon: typeof WrenchIcon; server?: string }
> = {
  search: { label: "Searched memory", icon: BrainIcon, server: "memory" },
  get: { label: "Read a memory", icon: BrainIcon, server: "memory" },
  doc: { label: "Read a document", icon: BrainIcon, server: "memory" },
  propose: { label: "Proposed a memory", icon: BrainIcon, server: "memory" },
  confirm: { label: "Confirmed a memory", icon: BrainIcon, server: "memory" },
  refute: { label: "Refuted a memory", icon: BrainIcon, server: "memory" },
  submit_patch: { label: "Submitted a patch", icon: GitPullRequestIcon },
  run_checks: { label: "Ran the checks", icon: CircleCheckBigIcon },
  check_status: { label: "Looked at the checks", icon: CircleCheckBigIcon },
  check_log: { label: "Read a check's log", icon: ScrollTextIcon },
  finish: { label: "Finished", icon: FlagIcon },
  get_issue: { label: "Read an issue", icon: CircleDotIcon },
  list_issues: { label: "Listed issues", icon: CircleDotIcon },
  get_change_request: { label: "Read a change request", icon: GitPullRequestIcon },
  list_change_requests: { label: "Listed change requests", icon: GitPullRequestIcon },
  create_issue: { label: "Opened an issue", icon: CircleDotIcon },
  close_issue: { label: "Closed an issue", icon: CircleDotIcon },
  add_comment: { label: "Commented", icon: MessageSquareIcon },
  add_labels: { label: "Labelled", icon: TagIcon },
  submit_review: { label: "Reviewed", icon: GitPullRequestIcon },
  expose_port: { label: "Exposed a preview", icon: GlobeIcon, server: "ryph" },
  background_run: { label: "Started a command", icon: SquareTerminalIcon, server: "ryph" },
  background_output: { label: "Read a command's output", icon: ScrollTextIcon, server: "ryph" },
  background_stop: { label: "Stopped a command", icon: CircleStopIcon, server: "ryph" },
  subagent_start: { label: "Started a subagent", icon: BotIcon, server: "ryph" },
  subagent_message: { label: "Messaged a subagent", icon: MessageSquareIcon, server: "ryph" },
  subagent_stop: { label: "Stopped a subagent", icon: CircleStopIcon, server: "ryph" },
};

// The agent's report of how its run stands, at every turn's end, and its finish: the row says which
// outcome it gave, since work still going on reads nothing like work done. A refused call recorded
// nothing, and its icon claims nothing either.
const REPORT_ICONS: Record<ReportedOutcome, typeof WrenchIcon> = {
  "in-progress": ClockIcon,
  done: CircleCheckIcon,
  "no-changes": CircleCheckIcon,
  failed: CircleXIcon,
  unknown: FlagIcon,
  refused: FlagIcon,
};

// Keyed on the tool's name rather than on the view kind, because the two do not line up: a call
// whose arguments did not parse into a view is `opaque` and still very much a `grep` or an `ls`,
// and the pill is where that shows. Anything unrecognised falls back on what it went through — a
// plug for the gateway, a wrench for a built-in this list has not met yet.
const TOOL_ICONS: Record<string, typeof WrenchIcon> = {
  bash: TerminalIcon,
  edit: PencilIcon,
  write: FilePlusIcon,
  read: EyeIcon,
  grep: SearchIcon,
  search: SearchIcon,
  websearch: SearchIcon,
  glob: FolderOpenIcon,
  ls: FolderOpenIcon,
  webfetch: GlobeIcon,
  fetch: GlobeIcon,
  todowrite: ListChecksIcon,
  todoread: ListChecksIcon,
  task: BotIcon,
};
/**
 * How a call presents itself: one icon and, for a tool the platform owns, one phrase. Exported
 * because the transcript draws the icon in its own marker column — a tool row used to carry two of
 * them, a terminal on the spine and the real one in the pill, which said `>_` twice on a bash row
 * and said terminal on a memory proposal.
 */
export function presentationFor(
  call: ToolCall,
  skill: SkillRead | null = null,
): { icon: typeof WrenchIcon; label: string | null } {
  // A read of one of the run's skills is the skill being loaded, and says so.
  if (skill !== null) {
    return {
      icon: BookOpenTextIcon,
      label: skill.file === "SKILL.md" ? "Loaded a skill" : "Read from a skill",
    };
  }
  // The run's browser: every tool has its own icon and says what it did to the page.
  if (call.view.kind === "browser") {
    return {
      icon: browserToolIcon(call.view.tool),
      label: describeBrowserCall(call.view.tool, call.view.args).label,
    };
  }
  if (
    call.view.kind === "mcp" && call.view.server === "ryph" &&
    (call.view.tool === "report_outcome" || call.view.tool === "finish")
  ) {
    const said = reportedOutcome(call.view.args, call);
    return {
      // A finish keeps its flag; only a report's icon says how the work stands.
      icon: call.view.tool === "finish" ? FlagIcon : REPORT_ICONS[said],
      label: outcomeCallLabel(call.view.tool, call.view.args, call),
    };
  }
  const name = call.view.kind === "mcp" ? call.view.tool : call.name;
  const known = PLATFORM_TOOLS[name];
  const platform = known !== undefined && call.view.kind === "mcp" &&
      (known.server === undefined || known.server === call.view.server)
    ? known
    : null;
  return {
    icon: platform?.icon ?? TOOL_ICONS[name.toLowerCase()] ??
      (call.view.kind === "mcp" ? PlugIcon : WrenchIcon),
    label: platform?.label ?? null,
  };
}
</script>

<script lang="ts">
import AttachmentImages from "$lib/components/attachment-images/attachment-images.svelte";
import CheckStateIcon from "$lib/components/check-state-icon/check-state-icon.svelte";
import CheckSuitePanel from "$lib/components/check-suite-panel/check-suite-panel.svelte";
import { Badge } from "$lib/components/ui/badge";
import * as Card from "$lib/components/ui/card";
import CodeView from "$lib/components/code-view/code-view.svelte";
import { Spinner } from "$lib/components/ui/spinner";
import { formatTime } from "$lib/utils/format";
import { tick, untrack } from "svelte";
import { countsLabel, suiteCounts } from "$lib/utils/checks";
import { getCheckSuitesContext, suitesInReply } from "./check-suites-context";
import { getRunSkillsContext } from "./run-skills-context";
import { skillRead } from "$lib/utils/skills";
import { HOOK_HELD_LABEL, isHeld } from "$lib/utils/hook-check";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import FileDiffView from "./file-diff-view.svelte";
import PatchPanel from "$lib/components/patch-panel/patch-panel.svelte";
import { getPatchesContext, submittedInReply } from "./patches-context";
import { getBackgroundJobsContext } from "./background-jobs-context";
import { backgroundCallOf, endedPhrase } from "$lib/utils/background";
import { getSubagentsContext } from "./subagents-context";
import { subagentCallOf, subagentStatus } from "$lib/utils/subagents";
import { Button } from "$lib/components/ui/button";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import { getPreviewsContext } from "./previews-context.svelte";
import { previewCallOf } from "$lib/utils/previews";

let { call, open = false, ontoggle }: {
  call: ToolCall;
  /**
   * Whether the body is open. A prop, not state: the transcript is windowed, so this row is
   * unmounted the moment it scrolls out of the list and mounted again when it comes back. What
   * was open has to be remembered somewhere that outlives the row, which is the history's
   * `expanded` set.
   */
  open?: boolean;
  ontoggle?: (open: boolean) => void;
} = $props();

// What the row says it acted on, next to the pill: a path for the file tools, the command itself
// for bash — which is the whole of what a bash call is, and the only one of these worth reading
// before deciding to open the row — and for a gateway call, the server it went to. A platform tool
// says nothing here: its label already names the thing, and "via memory" beside "Proposed a
// memory" is the same word twice.
const runSkills = getRunSkillsContext();
const skill = $derived(
  call.view.kind === "read" ? skillRead(call.view.path, runSkills?.() ?? null) : null,
);
// A background command call names its job, as the Commands tab lists it, and opens it there.
const pageJobs = getBackgroundJobsContext();
const pagePreviews = getPreviewsContext();
const previewCall = $derived(previewCallOf(call));
// Match the registered URL too: a later exposure of the same port is not this old preview.
const activePreview = $derived.by(() => {
  const exposed = previewCall;
  if (exposed?.url == null || pagePreviews?.status !== "ready") return undefined;
  return pagePreviews?.previews.find((preview) =>
    preview.url === exposed.url && preview.port === exposed.port
  );
});
const background = $derived(backgroundCallOf(call));
const backgroundJob = $derived(
  background?.jobId == null ? undefined : pageJobs?.job(background.jobId),
);
const backgroundSubject = $derived(
  background === null ? null : (background.label ?? backgroundJob?.label ?? background.jobId),
);
const backgroundState = $derived(
  backgroundJob === undefined
    ? null
    : backgroundJob.endedAt === null || backgroundJob.reason === null
    ? "running"
    : endedPhrase({
      reason: backgroundJob.reason,
      exitCode: backgroundJob.exitCode,
      signal: backgroundJob.signal,
    }),
);

// A subagent call names the subagent it started or spoke to, as the Subagents tab lists it, and
// opens it there.
const pageSubagents = getSubagentsContext();
const subagentCall = $derived(subagentCallOf(call));
const namedSubagent = $derived(
  subagentCall?.id == null ? undefined : pageSubagents?.subagent(subagentCall.id),
);
const subagentSubject = $derived(
  subagentCall === null ? null : (subagentCall.label ?? namedSubagent?.label ?? subagentCall.id),
);
const subagentState = $derived(
  namedSubagent === undefined
    ? null
    : subagentStatus(namedSubagent, Date.now()).label.toLowerCase(),
);

const subject = $derived(
  previewCall !== null
    ? `${previewCall.label} · :${previewCall.port}`
    : subagentCall !== null
    ? subagentSubject
    : background !== null
    ? backgroundSubject
    : skill !== null
    ? (skill.file === "SKILL.md" ? skill.name : `${skill.name}/${skill.file}`)
    : call.view.kind === "opaque" || call.view.kind === "chat"
    ? null
    : call.view.kind === "bash"
    ? call.view.command
    : call.view.kind === "browser"
    ? describeBrowserCall(call.view.tool, call.view.args).subject
    : call.view.kind === "mcp"
    ? (presentationFor(call).label === null ? `via ${call.view.server}` : null)
    : call.view.path,
);

// The pill's name: for a gateway call the remote tool's own name, since the server is already the
// subject beside it and the `<slug>__` prefix is the extension's plumbing, not the tool.
const shownName = $derived(
  call.view.kind === "mcp" || call.view.kind === "browser" ? call.view.tool : call.name,
);
const presentation = $derived(presentationFor(call, skill));

// A checks tool shows the suite it started or read, live, rather than only its reply: where the
// page holds the run's suites (the task page does), the card is the suite's own, and its state is
// on the row while it is shut.
const pageSuites = getCheckSuitesContext();
const checksTool = $derived(
  call.view.kind === "mcp" && presentation.label !== null &&
    (call.view.tool === "run_checks" || call.view.tool === "check_status"),
);
// The checks a run of only some of them named; none for a run of all of them.
const namedChecks = $derived.by(() => {
  if (call.view.kind !== "mcp" || call.view.tool !== "run_checks") return [];
  const args = call.view.args as { checks?: unknown } | null | undefined;
  return Array.isArray(args?.checks)
    ? args.checks.filter((c): c is string => typeof c === "string")
    : [];
});
// A status reply lists every suite of the run, newest first: the newest is what it was asked for.
const replySuites = $derived.by(() => {
  if (!checksTool || call.view.kind !== "mcp" || !call.view.output) return [];
  const held = pageSuites?.();
  const found = suitesInReply(
    call.view.output,
    held?.suites ?? [],
    held?.runId ?? null,
    namedChecks,
  );
  return call.view.tool === "check_status" ? found.slice(0, 1) : found;
});
const rowSuite = $derived(replySuites.length === 1 ? replySuites[0] : null);
// A run of some of the checks says which.
const label = $derived(
  namedChecks.length > 0 && presentation.label !== null
    ? `Ran ${namedChecks.join(", ")}`
    : background?.tool === "output" && background.jobId === null
    ? "Listed the commands"
    : presentation.label,
);

// A submitted patch shows itself as a card rather than as its JSON: what the agent called it and
// wrote about it, and, where the page holds the run's patches (the task page does), the patch as
// it stands now, with its state on the row while it is shut. A call that failed keeps its reply,
// which is the part worth reading.
const pagePatches = getPatchesContext();
const submitted = $derived.by(() => {
  if (call.view.kind !== "mcp" || presentation.label === null) return null;
  if (call.view.tool !== "submit_patch" || call.isError || !call.view.output) return null;
  const reply = submittedInReply(call.view.output);
  if (reply === null) return null;
  const args = (call.view.args ?? {}) as { repo?: unknown; title?: unknown; description?: unknown };
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  return {
    ...reply,
    patch: pagePatches?.().find((p) => p.id === reply.patchId) ?? null,
    repo: text(args.repo),
    title: text(args.title),
    description: text(args.description),
  };
});

/** A gateway call's arguments as the model sent them; the extension passes them through as JSON. */
function argsText(args: unknown): string | null {
  if (args === undefined || args === null) return null;
  if (typeof args === "object" && Object.keys(args).length === 0) return null;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

// How big the change was, for the rows that made one. Every row stays closed until asked, so this
// is what a shut row offers instead: enough to tell a one-line touch-up from a rewrite, and to pick
// which one to open.
const stat = $derived(
  call.view.kind === "write" || call.view.kind === "edit" ? call.view.stat : null,
);

/**
 * What the two renderers below actually take, as their own deriveds rather than read straight off
 * `call.view` in the markup. A `$derived` that recomputes to the same string notifies nobody, and
 * that is the point: this row's `call` is re-read whenever the transcript rebuilds its rows, which
 * a live tail makes it do on every event, and a prop reading `call.view.content` tracks the row's
 * signal rather than the string's value. The highlighter's effect then re-runs, tears its render
 * down (the card drops to its plain fallback, and loses a hundred-odd pixels with it) and rebuilds
 * it asynchronously — which a transcript following the tail scrolls against.
 *
 * The other half of that rule is upstream: `mergeToolCalls` hands back the SAME `ToolCall` for a
 * call whose facts have not changed. This is the boundary that holds even when one does change
 * somewhere else on the page.
 */
const viewPath = $derived("path" in call.view ? call.view.path : "");
const viewContent = $derived(
  call.view.kind === "read" || call.view.kind === "write" ? call.view.content : "",
);
const viewPatch = $derived(call.view.kind === "edit" ? call.view.patch : null);

// The bodies that draw through the syntax highlighter, and so are not their real size the moment
// they mount. Everything else is plain markup and is done as soon as it exists.
const drawsAsync = $derived(
  call.view.kind === "write" || call.view.kind === "edit" || call.view.kind === "read",
);

// A row that mounts already open is a row the reader scrolled back to, not one they just
// opened: it is built and revealed on the spot, with no animation to play. The reveal below is
// for the act of opening, and there was no act.
// `untrack`, because these ARE the initial value and only that: what the row was when it
// mounted, which the effect below takes over from.
let built = $state(untrack(() => open)); // the body exists (kept once built)
let drawn = $state(false); // ...and has settled at the size it will be
let revealed = $state(untrack(() => open)); // what the animation is playing towards
const panelId = $props.id();

$effect(() => {
  if (drawsAsync) warmRenderer();
});

/**
 * Open onto a body that is already the size it will be. The reveal is a height animation, so it
 * can only run once the thing being revealed knows its own height — a diff mounts as an empty div
 * and fills in only when the highlighter has drawn it, which is why opening used to animate to
 * nothing and then snap to full size once the chunk landed. So: build it collapsed, let it draw
 * behind the fold, and animate once it reports itself settled.
 *
 * Driven by the prop rather than by the click, because the click only asks: whoever holds the
 * open rows decides, and the row follows. `wasOpen` is plain, not state — it is the last value
 * this effect acted on, and reading it reactively would make the effect answer itself.
 */
let wasOpen = untrack(() => open);
$effect(() => {
  if (open === wasOpen) return;
  wasOpen = open;
  if (!open) {
    revealed = false;
    return;
  }
  built = true;
  if (!drawsAsync) drawn = true;
  if (drawn) void reveal();
});

async function reveal(): Promise<void> {
  await tick(); // the body is in the DOM, collapsed
  // Two frames: the browser has to have taken 0fr as a real start value before 1fr can be a
  // transition rather than a jump. A body built in this same frame has not been through style
  // resolution yet, so one frame is not always enough.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (open) revealed = true;
    })
  );
}

/** The body reports itself drawn — reveal it if it is still wanted. */
function onready(): void {
  drawn = true;
  if (open) reveal();
}
</script>

<!-- A gateway call as one panel, the same shape as bash: what was sent, then what came back. The
     gateway recorded this call too (the run's tool-call trail); this is the model's side of it. -->
{#snippet gatewayPanel(
  server: string,
  tool: string,
  rawArgs: unknown,
  output: string | null,
  dropped: boolean = false,
)}
  {@const args = argsText(rawArgs)}
  <div class="bg-muted overflow-hidden rounded-xl font-mono text-xs">
    <!-- The arguments sit beside the tool's path while there is room for them to read
         as a block, and drop under it when there is not, rather than being squeezed
         into a column a few characters wide. -->
    <div class="flex flex-wrap gap-x-2 gap-y-1 px-3 py-2">
      <span class="text-muted-foreground shrink-0 select-none">
        {server}/{tool}
      </span>
      {#if args}
        <pre
          class="min-w-[min(100%,20rem)] flex-1 overflow-x-auto whitespace-pre-wrap">{args}</pre>
      {:else}
        <span class="text-muted-foreground italic">no arguments</span>
      {/if}
    </div>
    {#if dropped}
      <div class="text-muted-foreground border-t px-3 py-2 italic">
        Too large to keep in the run's history
      </div>
    {:else if output === null}
      <div class="text-muted-foreground border-t px-3 py-2">Running…</div>
    {:else if output === ""}
      <div class="text-muted-foreground border-t px-3 py-2 italic">No content</div>
    {:else}
      <pre
        class="max-h-80 overflow-auto border-t px-3 py-2 whitespace-pre-wrap"
        class:text-destructive={call.isError}>{output}</pre>
    {/if}
  </div>
{/snippet}

<!-- The card's chrome is the disclosure: bare in the timeline until opened, then a real card
     around what it opened onto. Collapsed it matches the machinery around it; expanded it frames
     the diff without ever claiming to be the agent speaking.

     A button rather than <details>: the native element hides its own content the instant `open`
     flips, and this reveals on its own schedule — only once what it is revealing has drawn. -->
<!-- Collapsed, the outline is held at transparent rather than removed: the ring is a box-shadow, so
     it costs no layout at either end and only its colour moves, which is what makes the hover and
     the reveal fades rather than switches. Hover brings up the outline alone — the card offering
     itself before it is a card. The fill only arrives once the row is actually open.

     `relative` is what the button's stretched hit area below resolves against: the outline hover
     covers the whole card, so the click has to as well, or the card lights up somewhere it cannot
     be clicked. -->
<!-- One variable sets all four sides here: `--card-spacing` is the card's `py`, its content's `px`
     and the `-mx` that bleeds it back out again. Set rather than taking `size="sm"`, because these
     are rows in a timeline and not cards on a page — at that size the padding was 16px, which read
     as a wide frame around a one-line row, and the surface a revealed one paints reached into the
     space between rows. The `-mx` is this row's own — a card sits in its column by default — and
     cancels the card's `px`, which is what keeps a row's text in line with the rest of the
     transcript while the row's surface reaches 8px past it on each side. -->
<Card.Root
  class="relative -mx-(--card-spacing) [--card-spacing:--spacing(2)] transition-[background-color,box-shadow] duration-200 ease-out motion-reduce:transition-none {revealed
    ? ''
    : 'bg-transparent ring-transparent hover:ring-border'}"
>
  <!-- No gap of its own: the card primitive puts one between its rows, and the body below is a
       flex item even while it is shut — a gap above a zero-height body is height the row keeps
       for as long as it has ever been opened, and height stacked on the body's own `mt-3` while
       it is open. An open body's spacing belongs inside its clip box, where it collapses with
       the body. -->
  <Card.Content class="gap-0">
    <!-- The toggle's ::after stretches over the whole card while it is shut, so the padding around
         this row toggles too — one real button still, rather than a click handler on the card: the
         row stays reachable by keyboard and nothing double-fires on the way up. Once the row opens
         the header is what positions it, since an overlay across the card would eat every drag
         over the diff. The time sits outside the button, under the overlay, so that "Show output"
         can stand beside it without nesting one button in another. -->
    <div class={["@container flex items-center gap-2", revealed && "relative"]}>
      <button
        type="button"
        onclick={() => ontoggle?.(!open)}
        aria-expanded={open}
        aria-controls={panelId}
        class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left after:absolute after:inset-0"
      >
        <Badge variant={call.isError ? "destructive" : "secondary"}>
          {#if label}
            {label}
          {:else}
            {call.view.kind === "mcp" ? "Called" : "Used"} <span class="font-mono">{shownName}</span>
          {/if}
        </Badge>
        <ChevronRightIcon
          class="text-muted-foreground size-3.5 shrink-0 transition-transform {open
            ? 'rotate-90'
            : ''}"
        />
        {#if subject}
          <bdi class="text-muted-foreground truncate font-mono text-xs">{subject}</bdi>
        {/if}
        {#if submitted?.patch && isHeld(submitted.patch)}
          <!-- Held for its git hook files: a person has to approve it, and the open card says why. -->
          <span class="text-destructive flex min-w-0 items-center gap-1 text-xs font-medium">
            <TriangleAlertIcon class="size-3.5 shrink-0" />
            <span class="truncate">{HOOK_HELD_LABEL}</span>
          </span>
        {:else if submitted?.patch}
          <span class="text-muted-foreground truncate text-xs">
            {submitted.patch.landed?.kind === "missed"
              ? "not in merge"
              : (submitted.patch.landed?.kind ?? submitted.patch.state.replace("_", " "))}
          </span>
        {/if}
        {#if backgroundState !== null}
          <span class="text-muted-foreground min-w-0 truncate text-xs">{backgroundState}</span>
        {/if}
        {#if subagentState !== null}
          <!-- The label matters more than the standing on a narrow row. -->
          <span class="text-muted-foreground hidden min-w-0 truncate text-xs @sm:inline">
            {subagentState}
          </span>
        {/if}
        {#if rowSuite !== null}
          <span class="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
            <CheckStateIcon state={rowSuite.state} class="size-3.5" />
            <span class="truncate">{countsLabel(suiteCounts(rowSuite))}</span>
          </span>
        {/if}
        {#if !call.done}
          <Spinner class="text-muted-foreground size-3.5 shrink-0" />
        {/if}
      </button>
      <!-- Positioned, so it paints over the toggle's overlay and takes its own clicks. h-5 is the
           badge's height, the tallest thing on the row, so the row is no taller for having it. In a
           narrow row it is the icon alone, so the badge and state are not run under it. -->
      {#if activePreview}
        <Button
          variant="ghost"
          size="xs"
          class="text-muted-foreground relative h-5"
          href={pagePreviews?.href(activePreview)}
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLinkIcon data-icon="inline-start" />
          <span class="sr-only @md:not-sr-only">Open preview</span>
        </Button>
      {:else if previewCall?.url}
        <span class="text-muted-foreground relative text-xs">
          {pagePreviews?.status === "ended"
            ? "Preview ended"
            : pagePreviews?.status === "loading"
            ? "Finding preview…"
            : "Preview unavailable"}
        </span>
      {/if}
      {#if pageJobs && background?.jobId && pageJobs.knows(background.jobId)}
        {@const jobId = background.jobId}
        <Button
          variant="ghost"
          size="xs"
          class="text-muted-foreground relative h-5"
          onclick={() => pageJobs.open(jobId)}
        >
          <SquareTerminalIcon data-icon="inline-start" />
          <span class="sr-only @md:not-sr-only">Show output</span>
        </Button>
      {/if}
      {#if pageSubagents && subagentCall?.id}
        {@const subagentId = subagentCall.id}
        <Button
          variant="ghost"
          size="xs"
          class="text-muted-foreground relative h-5"
          onclick={() => pageSubagents.open(subagentId)}
        >
          <BotIcon data-icon="inline-start" />
          <span class="sr-only @md:not-sr-only">Show subagent</span>
        </Button>
      {/if}
      <!-- The counts travel with the time rather than trailing the path: a path is as long as it
           is, and a count that followed it landed somewhere different on every row. `pr-2` is for
           the card's rounded corner, which the time would otherwise sit in the notch of; it lands
           on the same x as every other row's time, which the list insets by the same amount. -->
      <span
        class="text-muted-foreground flex shrink-0 items-baseline gap-1.5 pr-2 text-xs"
      >
        {#if stat}
          <!-- A zero side is dropped rather than shown: `write` never removes anything, so a "-0"
               would ride along on every one of them saying nothing. The `+0` is kept only when it
               is the whole story, which is a write of an empty file. -->
          <span class="flex gap-1.5 font-mono">
            {#if stat.added > 0 || stat.removed === 0}
              <span class="text-diff-added">+{stat.added}</span>
            {/if}
            {#if stat.removed > 0}
              <span class="text-diff-removed">-{stat.removed}</span>
            {/if}
          </span>
          <span aria-hidden="true">·</span>
        {/if}
        {formatTime(call.at)}
      </span>
    </div>

    {#if built}
      <!-- A grid animated between 0fr and 1fr, rather than a slide: the row resolves against
           whatever the body's natural height turns out to be, so nothing has to measure it up
           front and a body that draws late still opens to its real size. -->
      <div
        id={panelId}
        inert={!revealed}
        class="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
        style:grid-template-rows={revealed ? "1fr" : "0fr"}
      >
        <div class="overflow-hidden">
          <div class="mt-3 flex flex-col gap-2">
          <!-- Any tool's images, kept as the run's attachments: a screenshot, or an image file the
               agent read. One it could not keep is only counted. -->
          {#if call.images.kept.length > 0}
            <AttachmentImages runId={call.runId} attachments={call.images.kept} />
          {/if}
          {#if call.images.notKept > 0}
            <p class="text-muted-foreground text-xs">
              {call.images.notKept === 1 ? "Image not kept" : `${call.images.notKept} images not kept`}
            </p>
          {/if}
          {#if call.view.kind === "edit"}
            <FileDiffView name={viewPath} patch={viewPatch} {onready} />
          {:else if call.view.kind === "write"}
            <FileDiffView name={viewPath} content={viewContent} {onready} />
          {:else if call.view.kind === "read"}
            <!-- Not a diff — nothing changed. The file as it was, numbered, with the language
                 inferred from its own path. -->
            <CodeView code={viewContent} name={viewPath} lineNumbers {onready} />
          {:else if call.view.kind === "bash"}
            <!-- One panel, prompt then output, the way a terminal reads. Hand-built rather than a
                 CodeView per half: nesting the renderer's own surface inside this one is what put
                 a second background inside the first last time. -->
            <div class="bg-muted overflow-hidden rounded-xl font-mono text-xs">
              <div class="flex gap-2 px-3 py-2">
                <span class="text-muted-foreground shrink-0 select-none">$</span>
                <pre class="overflow-x-auto whitespace-pre-wrap">{call.view.command}</pre>
              </div>
              {#if call.view.output === null}
                <div class="text-muted-foreground border-t px-3 py-2">Running…</div>
              {:else if call.view.output === ""}
                <div class="text-muted-foreground border-t px-3 py-2 italic">
                  No output
                </div>
              {:else}
                <pre
                  class="max-h-80 overflow-auto border-t px-3 py-2 whitespace-pre"
                  class:text-destructive={call.isError}>{call.view.output}</pre>
              {/if}
            </div>
          {:else if submitted}
            <PatchPanel
              patchId={submitted.patchId}
              patch={submitted.patch}
              repo={submitted.repo}
              headSha={submitted.headSha}
              generation={submitted.generation}
              title={submitted.title}
              description={submitted.description}
            />
          {:else if call.view.kind === "browser"}
            {@render gatewayPanel(
              "browser",
              call.view.tool,
              call.view.args,
              call.view.truncated ? null : call.view.output,
              call.view.truncated,
            )}
          {:else if call.view.kind === "mcp"}
            {#each replySuites as suite (suite.id)}
              <CheckSuitePanel {suite} />
            {/each}
            {@render gatewayPanel(call.view.server, call.view.tool, call.view.args, call.view.output)}
          {:else}
            {#if call.useText}
              <pre
                class="max-h-96 overflow-auto font-mono text-xs whitespace-pre-wrap">{call.useText}</pre>
            {/if}
            {#if call.resultText}
              <pre
                class="text-muted-foreground max-h-96 overflow-auto font-mono text-xs whitespace-pre-wrap"
                class:text-destructive={call.isError}>{call.resultText}</pre>
            {/if}
          {/if}

          </div>
        </div>
      </div>
    {/if}
  </Card.Content>
</Card.Root>
