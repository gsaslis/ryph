<script lang="ts">
import type { RunMessage, RunSkills } from "$lib/api/types";
import type { RunHistory, TranscriptRow } from "$lib/components/run-history/run-history.svelte";
import AgentAvatar from "$lib/components/agent-avatar/agent-avatar.svelte";
import AttachmentImages from "$lib/components/attachment-images/attachment-images.svelte";
import ForgeRepoLabel from "$lib/components/forge-repo-label/forge-repo-label.svelte";
import AgentThrobber from "$lib/components/agent-throbber/agent-throbber.svelte";
import Markdown from "$lib/components/markdown/markdown.svelte";
import RunResult from "$lib/components/run-result/run-result.svelte";
import AgentActivity from "./agent-activity.svelte";
import PlatformNotice from "./platform-notice.svelte";
import {
  inboxNoticeActions,
  inboxNoticeSummary,
  isInboxNotice,
  runnerChecksPayload,
  runnerNoticeDetails,
  runnerNoticeSummary,
} from "./platform-notice";
import { parseFireMessage } from "./alert-message";
import { placementFor, spliceOf } from "./splice";
import { TranscriptArrivals } from "./arrivals";
import ToolCallView, { presentationFor } from "$lib/components/tool-call/tool-call.svelte";
import * as Avatar from "$lib/components/ui/avatar";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Collapsible from "$lib/components/ui/collapsible";
import { Spinner } from "$lib/components/ui/spinner";
import { shortCommit, systemPayloadLabel } from "$lib/utils/environments";
import { formatCount, formatElapsed, formatRelativeTime, formatTime } from "$lib/utils/format";
import { personInitials } from "$lib/utils/avatar";
import { browserUnavailableReason } from "$lib/utils/browser-tools";
import { parseSkillDrop, skillRead } from "$lib/utils/skills";
import { getRunSkillsContext } from "$lib/components/tool-call/run-skills-context";
import { getBackgroundJobsContext } from "$lib/components/tool-call/background-jobs-context";
import { getSubagentsContext } from "$lib/components/tool-call/subagents-context";
import { noticeFailed, noticeSentence } from "$lib/utils/background";
import { getPatchesContext, getPatchesRefresh } from "$lib/components/tool-call/patches-context";
import HookWarning from "$lib/components/hook-warning/hook-warning.svelte";
import {
  heldNoticeLine,
  HOOK_NOTICE_PAST_LABEL,
  isHeld,
  isHeldNotice,
} from "$lib/utils/hook-check";
import JumpToBottom from "./jump-to-bottom.svelte";
import BookOpenTextIcon from "@lucide/svelte/icons/book-open-text";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import CircleIcon from "@lucide/svelte/icons/circle";
import CheckStateIcon from "$lib/components/check-state-icon/check-state-icon.svelte";
import CloudOffIcon from "@lucide/svelte/icons/cloud-off";
import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
import MessageCircleDashedIcon from "@lucide/svelte/icons/message-circle-dashed";
import MessageSquareIcon from "@lucide/svelte/icons/message-square";
import MonitorOffIcon from "@lucide/svelte/icons/monitor-off";
import MessageSquareOffIcon from "@lucide/svelte/icons/message-square-off";
import SquareTerminalIcon from "@lucide/svelte/icons/square-terminal";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import { onMount, tick, untrack } from "svelte";
import { Virtualizer, WindowVirtualizer } from "virtua/svelte";
import { endLabel, laneMarkOf, modeLabel } from "$lib/utils/subagents";
import BotIcon from "@lucide/svelte/icons/bot";
import FlagIcon from "@lucide/svelte/icons/flag";

let {
  history,
  agentId,
  agentName,
  senderLabel,
  initialOffset = null,
  trailing = 0,
  activity = "working",
  skills = null,
  contained = false,
  parentName = null,
  bot = false,
}: {
  /**
   * The run's history, which owns the rows, what is open in them and how to fetch what is not
   * loaded. Passed whole rather than as six props: every one of them is about the same list, and
   * a windowed row reaches back to it on mount (to open itself) and on scroll (to fetch).
   */
  history: RunHistory;
  agentId: string;
  agentName: string;
  senderLabel: (message: RunMessage) => string;
  /**
   * Where the window was when this was last unmounted — switching to another tab and back. Null
   * is a first arrival, which opens at the end of the run.
   */
  initialOffset?: number | null;
  /**
   * How tall the page's own content UNDER this transcript is — a live run draws its
   * message box there. Zero when there is none.
   *
   * The number is a signal, not the measurement: `trailingPx` below works out the real distance
   * off the document, because the gap between that box and this one, and whatever the page ends
   * with, are part of it too. What the prop is for is knowing WHEN it changed — the box grows as a
   * message is typed into it, which moves the bottom of the page without the list changing at all,
   * and a reader who was at the bottom should stay there rather than watch their own draft slide
   * off the screen.
   */
  trailing?: number;
  /**
   * What the agent is up to, which the live row's blob and its line say. `working` is excited, and
   * `idle` — the agent has finished its turn and is waiting to be spoken to — drifts. `pending`
   * is a run whose agent has not started (provisioning, waiting for its environment, cloning,
   * setting up) or has already stopped (finalizing): the blob drifts and says nothing, since
   * there is no agent to say anything about.
   */
  activity?: "pending" | "working" | "idle";
  /** The skills the run was given, which name the org repo version a stale-skills row is about. */
  skills?: RunSkills | null;
  /**
   * Scrolls in a box of its own, filling its parent, rather than with the page: a subagent's
   * transcript in the details pane. The page's own transcript is the window's.
   */
  contained?: boolean;
  /** Who handed a subagent its work, for the marks in its lane; null on the run's own. */
  parentName?: string | null;
  /**
   * The one speaking is a subagent rather than the agent itself: its rows wear a plain bot rather
   * than the agent's face, which belongs to the run's own transcript.
   */
  bot?: boolean;
} = $props();

// The run's skills, set by the page, so a read of one draws the skill's marker.
const runSkills = getRunSkillsContext();
// The run's background commands, where the page has a Commands tab to open one in.
const backgroundJobs = getBackgroundJobsContext();
// And its subagents, where it has a Subagents tab to open one in.
const subagents = getSubagentsContext();

const rows = $derived(history.rows);
const expanded = $derived(history.expanded);

// A patch held for its git hook files is approved from its notice, as the page holds it now. The
// notice's own text is written to the agent; once the patch has moved on, people read one plain
// line about it instead.
const pagePatches = getPatchesContext();
const patchesRefresh = getPatchesRefresh();
function heldNotice(message: RunMessage) {
  if (!isHeldNotice(message.payload)) return null;
  const id = message.payload.patchId;
  const patch = pagePatches?.().find((p) => p.id === id) ?? null;
  return patch !== null && isHeld(patch)
    ? { held: patch, line: null }
    : { held: null, line: heldNoticeLine(patch) };
}

/**
 * A row's key — and a key for a row that is not there. Total on purpose: this is called from
 * inside the virtualiser's own render, which is the middle of a Svelte flush, and an exception
 * there does not fail one row, it stops the whole page updating.
 *
 * The rows come from one run's history for this component's whole life, so the virtualiser asking
 * for an index past the end of them should not be a state this can be in. It was: the history was
 * shared between runs, and the list shrank under a virtualiser still holding the last run's row
 * count. The belt stays regardless — the list changing shape underneath it is not worth a dead page.
 *
 * A row the virtualiser has to measure again carries a generation after its key: a new key is a new
 * element, and a new element is the one thing it always measures (see `remounted` below).
 */
function keyOf(row: TranscriptRow | undefined, index: number): string {
  if (row === undefined) return `missing-${index}`;
  const remount = remounted.get(row.key);
  return remount === undefined ? row.key : `${row.key}~${remount}`;
}

/**
 * A windowed list: only the rows near the viewport are mounted, and the window is the document
 * itself — the page is window-scrolled on purpose (see the masthead's comment), so a scroll box
 * here would fight the sticky header and the message box below.
 *
 * `itemSize` is a hint for rows nothing has measured yet. It only has to be close: it is what the
 * list's height is guessed from before anything is on screen, which is what lets the open-at-the-
 * end scroll below land somewhere near the end on its very first try.
 */
const ROW_HINT = 56;

/** Whether the live row's verb is an evil one, which the face beside it follows. */
let evil = $state(false);

let list = $state<ReturnType<typeof WindowVirtualizer> | ReturnType<typeof Virtualizer> | null>(
  null,
);
/** The list's own box, which is what the distance to the bottom of the page is measured from. */
let wrapper = $state<HTMLDivElement | null>(null);

// Where the list scrolls: the window, or its own box when it is contained. Everything below that
// reads or moves the scroll goes through these, so the two read the same.
/** How far the scroller is scrolled. */
function scrollTop(): number {
  return contained ? (wrapper?.scrollTop ?? 0) : globalThis.scrollY;
}
/** The height of what scrolls. */
function scrollHeight(): number {
  return contained ? (wrapper?.scrollHeight ?? 0) : document.documentElement.scrollHeight;
}
/** The height of what is on screen of it. */
function viewportHeight(): number {
  return contained ? (wrapper?.clientHeight ?? 0) : globalThis.innerHeight;
}
function scrollToTop(top: number): void {
  if (contained) wrapper?.scrollTo({ top });
  else globalThis.scrollTo({ top });
}
/** The list is at the end and may be looked at. Until then it is drawn but not shown. */
let placed = $state(false);

/**
 * How far the bottom of the list is from the bottom of the document: the message box a
 * live run draws under it, the gap above that box, and whatever padding the page ends
 * with. Measured rather than taken from `trailing`, because only the page's own box is in the prop
 * and the space around it counts just as much — a scroll that lands 24px short of the bottom is a
 * scroll that hides the thing it was asked to bring into view.
 */
function trailingPx(): number {
  // A contained list is the whole of its box: nothing is drawn under it.
  if (wrapper === null || contained) return 0;
  const bottom = wrapper.getBoundingClientRect().bottom + globalThis.scrollY;
  return Math.max(0, Math.round(document.documentElement.scrollHeight - bottom));
}

/**
 * The end of the run, at the end of the PAGE. `offset` is virtua's own — it is added to the scroll
 * it works out for the row, and it is re-applied through the measuring loop the scroll runs, which
 * is what a bare `globalThis.scrollTo` cannot survive: the row is mounted only once it is scrolled
 * to, so the document is not yet as tall as it will be, and the virtualiser's correction takes the
 * window scroll back as the row reports its height.
 *
 * Without the offset this lands with the last row's bottom at the bottom of the WINDOW, which on a
 * live run is directly above the message box — every event snapped the page to just
 * above the thing the reader was about to type into.
 */
function toEnd(count: number): void {
  // A run that is less than one fold high has nowhere to go, and asking the virtualiser to take
  // it there is not free: `scrollToIndex` runs a measuring loop that scrolls, waits for the rows
  // it lands on to report their heights and scrolls again, and every one of those scrolls is a
  // correction applied to a document that cannot move. What came of it was a transcript nudged a
  // couple of dozen pixels down its own page, with the space that opened up at the top of it.
  if (fits()) return;
  list?.scrollToIndex(Math.max(0, count - 1), { align: "end", offset: trailingPx() });
}

/** The whole page is on screen: there is no scrolling to be done, and none to be asked for. */
function fits(): boolean {
  return scrollHeight() <= viewportHeight() + 1;
}

/**
 * Whether the virtualiser holds the rows after the latest change still, worked out from the change
 * itself in the update it lands in (see `placementFor`). The virtualiser reads it only when the row
 * count changes, and this runs before it does in that same update: a pre-effect of this component
 * comes ahead of everything in the virtualiser below it.
 *
 * It used to follow the history's "a page is loading above everything" flag, held up for 200ms
 * after the page landed. That was wrong twice. The page a scroll upwards fetches is the gap UNDER
 * the head of the run, so it lands in the middle of the list, not at its start, and holding still
 * for it handed every head row on screen another row's height — the first message drawn on top of
 * the rows after it, until it was scrolled away and back. And for those 200ms any change at all
 * counted as one at the start.
 */
let shift = $state(false);
/**
 * Rows that must mount again to be measured, by row key, and the generation that re-keyed them:
 * see `keyOf`. Plain, not state — it only ever changes in the same update as the rows, and that
 * change is what has the virtualiser read the keys again.
 */
const remounted = new Map<string, number>();
let generation = 0;
let seenKeys: string[] | null = null;
const arrivals = new TranscriptArrivals();
const entering = new Map<string, number>();

/** Animate layout, not just paint: virtua measures the growing row and moves the live row with it. */
function reveal(node: HTMLElement, row: TranscriptRow | undefined) {
  if (row === undefined) return;
  const arrivedAt = entering.get(row.key);
  entering.delete(row.key);
  // A row mounted later by scrolling is history, not a new arrival.
  if (
    arrivedAt === undefined || !placed || performance.now() - arrivedAt > 300 ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) return;
  const style = getComputedStyle(node);
  const animation = node.animate(
    [
      { height: "0px", paddingBottom: "0px", opacity: 0, overflow: "hidden" },
      {
        height: `${node.getBoundingClientRect().height}px`,
        paddingBottom: style.paddingBottom,
        opacity: 1,
        overflow: "hidden",
      },
    ],
    { duration: 300, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  );
  return { destroy: () => animation.cancel() };
}

$effect.pre(() => {
  const now = performance.now();
  for (const [key, at] of entering) {
    if (now - at > 300) entering.delete(key);
  }
  for (const key of arrivals.update(rows, history.lastSeq)) entering.set(key, now);
  const keys = rows.map((row) => row.key);
  const before = seenKeys;
  seenKeys = keys;
  // The first list is the one the virtualiser was created with: there is no change to place.
  if (before === null) return;
  const firstVisible = untrack(() => list?.findStartIndex() ?? 0);
  const placement = placementFor(spliceOf(before, keys), firstVisible);
  shift = placement.shift;
  if (placement.remeasure > 0) {
    generation++;
    for (const key of keys.slice(0, placement.remeasure)) remounted.set(key, generation);
  }
});

/**
 * Open at the end, before the reader sees anything. Twice: the first lands on the height the row
 * hint guessed, the second on the heights the rows report once they are mounted. Nothing is shown
 * until both have run, so the top of a long run never flashes past on the way down.
 */
onMount(() => {
  let cancelled = false;
  const offset = initialOffset;
  const place = () => {
    if (offset === null) toEnd(rows.length);
    else scrollToTop(offset);
  };
  void (async () => {
    place();
    await tick();
    requestAnimationFrame(() => {
      if (cancelled) return;
      place();
      placed = true;
    });
  })();
  return () => {
    cancelled = true;
  };
});

/**
 * Follow the tail, but only for as long as the reader is actually at the bottom — the moment they
 * scroll up to read something, or open a row to look at it, they are left where they are. The
 * window is the scroll container: nothing in the layout is a fixed-height overflow box, so "the
 * bottom" is the bottom of the document.
 *
 * "At the bottom" is the virtualiser's LAST ROW being in the window, not the document's own end:
 * a live run draws its message box below the transcript, and a run being watched live
 * draws rows the list has not measured yet — against the document, a reader parked at the end of
 * the run is several hundred pixels short of the bottom and would never be followed at all.
 *
 * It is also what holds a reader in place while they type: a message box that grows pushes the
 * bottom of the document away from them, and a rule written against that bottom would call them
 * scrolled-up the moment their draft reached a second line.
 */
let stuck = $state(true);
function atEnd(): boolean {
  const last = rows.length - 1;
  if (last < 0) return true;
  if ((list?.findEndIndex() ?? 0) >= last) return true;
  // The document's own end still counts — it is where a short run with nothing under it sits.
  return scrollHeight() - (scrollTop() + viewportHeight()) < 80;
}

/**
 * Back to the end, and following again — for the reader who has just said something to the run:
 * what they sent, and whatever answers it, is where they are looking next, however far up they had
 * scrolled.
 *
 * Chasing, not just following, until the reader scrolls by hand. The way down from far up is
 * several scrolls while the virtualiser measures the rows it lands on, and the ones in the middle
 * are not at the end — read by `onScroll` alone they would stop the follow halfway. And their
 * message arrives as a new row with no new seq, which the tail effect below does not count as the
 * run moving; while chasing, any new row at all does.
 */
let chasing = false;
export function follow(): void {
  chasing = true;
  stuck = true;
  toEnd(rows.length);
}
function stopChasing(): void {
  chasing = false;
}

/**
 * Bring the row for the event at `seq` to the middle of the window — a tool call picked from
 * somewhere else on the page (the browser's Actions). False when that part of the run is not
 * loaded, which only the reader scrolling to it can change.
 */
export function scrollToSeq(seq: number): boolean {
  const index = rows.findIndex((row) => seqOf(row) === seq);
  if (index === -1) return false;
  chasing = false;
  stuck = false;
  list?.scrollToIndex(index, { align: "center" });
  return true;
}
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
function stopChasingOnKey(event: KeyboardEvent): void {
  // A key scrolls the page only when nothing editable has it — arrows in the message box move the
  // caret, not the reader.
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, [contenteditable]")) return;
  if (SCROLL_KEYS.has(event.key)) stopChasing();
}

/**
 * Something new at the END of the run, which is the only kind of change that moves a reader who is
 * following. Not the row count alone: a page loading ABOVE grows that too, and yanking someone
 * reading the middle of a run down to its end is the opposite of what they asked for — so a grown
 * list moves only a reader who is already at the end (see below). Not the last row's
 * key either, on its own: while a run is live the last row is the "watching" spinner and its key
 * never changes, so the newest seq is what says the tail moved — and the key is what says a run
 * ended and grew a result row.
 *
 * Plain, not state: it is what this effect last acted on, and reading it reactively would make the
 * effect answer itself.
 */
let seenTail: string | null = null;
let seenTrailing = 0;
let seenCount = 0;
$effect(() => {
  const mark = `${history.lastSeq}:${rows.at(-1)?.key ?? ""}`;
  const count = rows.length;
  const grew = count !== seenCount;
  seenCount = count;
  // ...and the page's own box under the list growing, which moves the bottom of the page just as
  // surely as a row landing does. A reader at the bottom typing a long message is still at the
  // bottom, and following it is what keeps their draft on screen.
  const below = trailing;
  // ...and rows landing anywhere while the reader is at the end. The page opens on the head and
  // the tail with the hole between them as one gap row, and the read that fills the hole lands a
  // beat after the window is placed. On a run whose head and tail share a screen the gap is on
  // that screen, so the middle goes in UNDER the top of the window and pushes the end of the run
  // off the bottom of it: the page opened on the start of the middle, with no new seq to say the
  // tail moved. A reader who has scrolled up is not stuck, and is left where they are.
  if (mark === seenTail && below === seenTrailing && !grew) return;
  const first = seenTail === null;
  seenTail = mark;
  seenTrailing = below;
  // The first run is the transcript arriving; `place` above has the initial scroll.
  if (first || !untrack(() => stuck) || !untrack(() => placed)) return;
  toEnd(count);
});

/**
 * Where the reader is, in seqs — what eviction keeps its distance from. Read off the first row in
 * the window, which is one binary search and one array read; on every scroll frame rather than on
 * `scrollend`, because a reader flinging upward through a long run never stops scrolling long
 * enough to fire one, and eviction would then still believe they were at the tail — and drop the
 * pages under their eyes.
 *
 * The other half of this is the dead end at the top. The head of the run is loaded and drawn ABOVE
 * the gap, so a reader who climbs all the way up ends on it, with the gap a screen below and out
 * of the sentinel's reach; once eviction is holding the loaded height steady, a prepend no longer
 * pushes them off the top either, and scrolling up stops doing anything at all. Standing at the
 * top with a gap still open is itself the ask.
 */
function onScroll(): void {
  stuck = chasing || atEnd();
  const row = rows[list?.findStartIndex() ?? 0];
  const seq = row === undefined ? null : seqOf(row);
  if (seq !== null) history.noteViewport(seq);
  // ...and not until the window has been placed: until then the list is still at the TOP of the
  // loaded stretch, scrollY is 0 because nothing has scrolled yet, and this read it as a reader
  // standing at the head of the run asking for more. The page it fetched landed on top of a
  // placement that was still converging and left a long run open halfway down itself.
  //
  // `!stuck`, because standing at the top of the document only MEANS anything for a reader who
  // climbed there. On a run shorter than the fold the reader is at the end and at the top at the
  // same time, and `scrollY <= 0` is true on every frame for the rest of the page's life — which
  // asked for the next page, and the next, until the whole hole had been drained behind a
  // "Loading…" row nobody had scrolled to.
  //
  // `hasOlder`, because a rule that asks for what does not exist is a rule that says nothing:
  // `loadOlder` is a no-op at the head, and spelling that out here is what keeps the reading of
  // this line honest.
  if (placed && !stuck && history.hasOlder && scrollTop() <= 0) void history.loadOlder();
}

function seqOf(row: (typeof rows)[number]): number | null {
  switch (row.kind) {
    case "event":
      return row.event.seq;
    case "tool":
      return row.call.seq;
    case "background":
    case "subagent":
      return row.seq;
    case "gap":
      return row.before;
    default:
      return null;
  }
}

/**
 * A gap fetches itself when it comes into view: scrolling up through a run is what asks for more
 * of it, and the row at the top of the loaded stretch is the sentinel that says so. A gap whose
 * fetch failed does NOT re-fetch itself — it would try again on every frame it was visible — and
 * waits to be clicked instead.
 */
function sentinel(before: number, failed: boolean) {
  return (node: Element) => {
    // `placed` is read here, in the attachment itself, so the observer is made the moment the
    // window is placed and not before: a gap sitting in the first screen the list draws — which is
    // the TOP of the loaded stretch, before anything has scrolled — would otherwise fetch a page
    // into the middle of that placement. Nobody is looking at the list until it is placed.
    //
    // ...and not while the reader is still AT THE END of the run, which is the other half of the
    // same thought: a gap only fetches itself because somebody scrolled to it, and a reader who
    // has not left the end has scrolled to nothing. On a transcript shorter than one fold they
    // never will — the whole run is the end — so the gap there stays what the row already offers
    // anyone who would rather ask than scroll: a button. Without this, a short run whose hole is
    // too wide for the load to close opened, drew the gap on the first screen, and drained it two
    // hundred events at a time, redrawing "Loading N earlier events…" on every round.
    if (failed || !placed || stuck) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void history.loadGap(before);
      },
      // A little before it is actually on screen, so the page above is usually there by the time
      // the reader arrives at it.
      { root: contained ? wrapper : null, rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  };
}

function toggle(key: string, open: boolean): void {
  if (open) expanded.add(key);
  else expanded.delete(key);
  // Opening a row deliberately does NOT stop the transcript following a live run: where the reader
  // is, is the one rule, and a row opened at the end of a run is at the end of the run. New events
  // carry it up the screen as they land — it stays open the whole way, and scrolling away from the
  // end is how a reader says they would rather stay put.
}

/**
 * The first line of a thought, as its summary. The model opens a reasoning block with a heading
 * of its own — "Modifying README files" — which is a better one-line account of the thought than
 * anything this page could compose, once its markdown is taken off.
 */
function splitThought(text: string): { title: string; body: string; heading: boolean } {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trim() !== "");
  const first = at === -1 ? "" : lines[at].trim();
  // Only a line that is a heading gets promoted out of the body — the folded row is already
  // showing it, and a thought should not announce itself twice on the way open. Models that write
  // no heading keep every line of theirs: their first line is a sentence, and the row borrows it
  // as a label rather than taking it away. The markup drops that borrowed label once the row is
  // open, which is where it would otherwise read twice — once truncated, once in full.
  const heading = /^#{1,6}\s+/.test(first) || /^\*\*[^*]+\*\*$/.test(first);
  return {
    title: first.replace(/^#+\s*/, "").replaceAll("*", "").trim() || "Thinking",
    body: heading ? lines.slice(at + 1).join("\n").trim() : text,
    heading,
  };
}
</script>

<!-- Every row's time is held 8px off the right edge. A tool call's card bleeds out to that edge
     and curves, and at the edge itself the time sat in the notch of its own rounded corner; the
     inset is on all of them so the column of times stays a column.

     One spine, one marker column, content hanging off it. The four sources that feed this used to
     each bring their own shape — grey text with a diamond, a pill, a bordered card — and read as
     four systems stacked rather than one run happening. What distinguishes a row now is its
     marker and how much room its content earns, not its chrome.

     The spine is drawn per row rather than as one line down the list: each row carries the segment
     from its own marker to the next one — 11px down to clear the marker, then its own height plus
     the 12px it holds below itself — and the last row carries none. One line behind everything
     could only end at the bottom of the last row's content, which on a row that unfolds is a long
     way past its marker and read as a line running off into nothing. Markers punch their own holes
     in it either way, and the hole is the mark's own width, never the column's: a foldable row
     hangs its chevron back into that column, and a full-width opaque cell painted over half of it.

     The gap between rows is each row's own bottom padding rather than the list's `gap`: the
     virtualiser stacks rows by what they measure, and a gap it cannot see is a gap that is not
     there. The last row keeps its padding too — the message box below wants the same air.

     The wrapper's `-mx-4` is room for what a row draws outside the content column: the
     virtualiser's container clips (that is how it keeps a 50,000-row list from painting), and a
     tool call's card bleeds 8px past the column on both sides and curves there. The matching
     `px-4` is on the ROW, not here: on the wrapper it shrinks the content box, the container is
     laid out inside that, and the clip box lands back on the content column — which cut the right
     edge off every card. -->
<!-- What a reader does to scroll by hand, as opposed to the scrolls `follow` sets off. -->
<!-- Pointerdown covers dragging the scrollbar, which no wheel or touch event reports. -->
<svelte:window
  onwheel={stopChasing}
  ontouchmove={stopChasing}
  onpointerdown={stopChasing}
  onkeydown={stopChasingOnKey}
/>

<!-- A contained list scrolls in its own box, which is the virtualiser's direct parent: that is the
     element it scrolls by default. The box clips, so the room the window's list keeps for a card's
     bleed is the row's own padding here. -->
{#if contained}
  <div class="relative flex min-h-0 flex-1 flex-col">
  <div
  bind:this={wrapper}
  class={["min-h-0 flex-1 overflow-y-auto overscroll-contain pt-3", !placed && "invisible"]}
>
  <Virtualizer
    bind:this={list}
    data={rows}
    getKey={keyOf}
    itemSize={ROW_HINT}
    startMargin={12}
    {shift}
    onscroll={onScroll}
    children={transcriptRow}
  />
</div>
  {@render jumpToBottom()}
  </div>
{:else}
  <div bind:this={wrapper} class="-mx-4" class:invisible={!placed}>
  <WindowVirtualizer
    bind:this={list}
    data={rows}
    getKey={keyOf}
    itemSize={ROW_HINT}
    {shift}
    onscroll={onScroll}
    children={transcriptRow}
  />
  <div class="pointer-events-none sticky z-20 h-0 mx-4" style:bottom={`${trailing + 16}px`}>
    {@render jumpToBottom()}
  </div>
</div>
{/if}

{#snippet jumpToBottom()}
  {#if placed && !stuck && rows.length > 0}
    <JumpToBottom
  class={contained ? "right-4 bottom-4" : "right-0 bottom-0"}
  onclick={follow}
/>
  {/if}
{/snippet}

<!-- Who is speaking, beside their rows: the agent's face, or a subagent's bot, at the face's small
     size. -->
{#snippet face()}
  {#if bot}
    <span
  class="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full"
>
  <BotIcon class="size-3.5" aria-hidden="true" />
</span>
  {:else}
    <AgentAvatar {agentId} size="sm" />
  {/if}
{/snippet}

{#snippet transcriptRow(row: TranscriptRow | undefined, index: number)}
      <!-- The last row carries no spine, and it is HIDDEN rather than left unpositioned: a
           `before:` utility brings `content: ""` with it, and an unpositioned pseudo-element is a
           grid item like any other — it took the marker column and pushed the whole row one cell
           to the right, which is how the result row came out 34px wide. -->
      <div
  use:reveal={row}
  class="before:bg-border before:absolute before:top-[11px] before:-bottom-[11px] before:left-[31px] before:w-px relative grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-3 px-4 pb-3 {index ===
          rows.length - 1
          ? 'before:hidden'
          : ''}"
>
        {#if row === undefined}
          <!-- Past the end of the list: see `keyOf` above. Nothing to draw, and nothing thrown. -->
        {:else if row.kind === "gap"}
          <!-- What is not loaded, said as a row: how many events are missing, and the way to get
               them. It fetches itself when it scrolls into view; the button is for a fetch that
               failed, and for anyone who would rather ask than scroll. -->
          <div class="text-muted-foreground relative flex justify-center">
            <span class="bg-background flex py-1"><EllipsisIcon class="size-3.5" /></span>
          </div>
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground flex w-full items-baseline gap-2 py-0.5 text-left text-xs transition-colors"
            onclick={() => {
              // Asking for what is above is reading up: the page that lands must not follow the
              // reader back to the end of the run.
              chasing = false;
              stuck = false;
              void history.loadGap(row.before);
            }}
            {@attach sentinel(row.before, row.failed)}
          >
            {#if row.loading}
              <Spinner class="size-3.5 self-center" />
              Loading {formatCount(row.count)} earlier events…
            {:else if row.failed}
              <TriangleAlertIcon class="size-3.5 self-center" />
              Could not load these {formatCount(row.count)} events — try again
            {:else}
              Load {formatCount(row.count)} earlier events
            {/if}
          </button>
        {:else if row.kind === "machine"}
          {@const [first] = row.events}
          <div class="text-muted-foreground relative flex justify-center">
            <span class="bg-background flex py-1"><CircleIcon class="size-2.5" /></span>
          </div>
          <!-- One line on its own, in the run's transcript; a subagent's opens with pi's own
               `agent_start` and nothing of the run's around it, so even one is folded there. -->
          {#if row.events.length === 1 && !bot}
            <p class="text-muted-foreground flex items-baseline gap-2 py-0.5 text-xs">
              <span class="font-medium">{first.kind}</span>
              {#if first.detail}<span class="truncate">{first.detail}</span>{/if}
              <span class="ml-auto shrink-0 pr-2">{formatTime(first.at)}</span>
            </p>
          {:else}
            <Collapsible.Root
              class="group/row min-w-0"
              open={expanded.has(row.key)}
              onOpenChange={(open) => toggle(row.key, open)}
            >
              <Collapsible.Trigger
                class="text-muted-foreground hover:text-foreground -ml-[1.125rem] flex w-[calc(100%+1.125rem)] items-baseline gap-1.5 py-0.5 text-xs transition-colors"
              >
                <ChevronRightIcon
                  class="size-3 shrink-0 self-center transition-transform group-data-[state=open]/row:rotate-90"
                />
                {row.events.length} run {row.events.length === 1 ? "event" : "events"}
                <span class="ml-auto shrink-0 pr-2">{formatTime(first.at)}</span>
              </Collapsible.Trigger>
              <Collapsible.Content>
                <div class="text-muted-foreground flex flex-col gap-1 pt-2 text-xs">
                  {#each row.events as event (event.key)}
                    <p class="flex items-baseline gap-2">
                      <span class="font-medium">{event.kind}</span>
                      {#if event.detail}<span class="truncate">{event.detail}</span>{/if}
                      <span class="ml-auto shrink-0 pr-2">{formatTime(event.at)}</span>
                    </p>
                  {/each}
                </div>
              </Collapsible.Content>
            </Collapsible.Root>
          {/if}
        {:else if row.kind === "limit"}
          <div class="text-muted-foreground relative flex justify-center">
            <span class="bg-background flex py-1">
              <TriangleAlertIcon class="text-destructive size-3.5" />
            </span>
          </div>
          <p class="flex items-baseline gap-2 py-0.5 text-xs">
            <span class="font-medium">Reached a limit</span>
            <span class="text-muted-foreground truncate">{row.detail}</span>
            <span class="text-muted-foreground ml-auto shrink-0 pr-2">{formatTime(row.at)}</span>
          </p>
        {:else if row.kind === "stale"}
          <div class="text-muted-foreground relative flex justify-center">
            <span class="bg-background flex py-1">
              <CloudOffIcon class="text-destructive size-3.5" />
            </span>
          </div>
          <p class="flex items-baseline gap-2 py-0.5 text-xs">
            <span class="shrink-0 font-medium">Started from the forge's cache</span>
            <span class="text-muted-foreground min-w-0">{row.detail}</span>
            <span class="text-muted-foreground ml-auto shrink-0 pr-2">{formatTime(row.at)}</span>
          </p>
        {:else if row.kind === "browser"}
          <div class="text-muted-foreground relative flex justify-center">
            <span class="bg-background flex py-1">
              <MonitorOffIcon class="size-3.5" />
            </span>
          </div>
          <div class="flex items-baseline gap-2 py-0.5 text-xs">
            <div class="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
              <span class="font-medium sm:shrink-0">Started without a browser</span>
              <span class="text-muted-foreground min-w-0 wrap-anywhere">{browserUnavailableReason(row.detail)}</span>
            </div>
            <span class="text-muted-foreground shrink-0 pr-2">{formatTime(row.at)}</span>
          </div>
        {:else if row.kind === "unbound"}
          <div class="text-muted-foreground relative flex justify-center">
            <span class="bg-background flex py-1">
              <MessageSquareOffIcon class="size-3.5" />
            </span>
          </div>
          <p class="flex items-baseline gap-2 py-0.5 text-xs">
            <span class="shrink-0 font-medium">Couldn't post in the conversation</span>
            <span class="text-muted-foreground min-w-0">{row.detail}</span>
            <span class="text-muted-foreground ml-auto shrink-0 pr-2">{formatTime(row.at)}</span>
          </p>
        {:else if row.kind === "setup"}
          <div class="text-muted-foreground relative flex justify-center">
            <span class="bg-background flex py-1">
              <TriangleAlertIcon class="text-destructive size-3.5" />
            </span>
          </div>
          <!-- A repo's setup did not finish (a step failed, or setup.yml was invalid) and the run
               went on: a warning, not the end of the run. The step's output or the file's error
               is the repo's, shown as plain text on demand. -->
          <div class="flex items-baseline gap-2 py-0.5 text-xs">
            <div class="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
              <span class="font-medium sm:shrink-0">
                {row.discarded ? "Setup changes discarded" : "Setup didn't finish"}
              </span>
              <span class="text-muted-foreground min-w-0 wrap-anywhere">{row.summary}</span>
            </div>
            <span class="text-muted-foreground shrink-0 pr-2">{formatTime(row.at)}</span>
          </div>
          {#if row.output}
            <Collapsible.Root
              class="group/row min-w-0"
              open={expanded.has(row.key)}
              onOpenChange={(open) => toggle(row.key, open)}
            >
              <Collapsible.Trigger
                class="text-muted-foreground hover:text-foreground flex items-center gap-1 py-0.5 text-xs transition-colors"
              >
                <ChevronRightIcon
                  class="size-3 shrink-0 transition-transform group-data-[state=open]/row:rotate-90"
                />
                Details
              </Collapsible.Trigger>
              <Collapsible.Content>
                <pre
                  class="bg-muted text-muted-foreground mt-1 max-h-64 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap wrap-anywhere">{row.output}</pre>
              </Collapsible.Content>
            </Collapsible.Root>
          {/if}
        {:else if row.kind === "background"}
          {@const notice = row.notice}
          {@const failed = noticeFailed(notice)}
          <div class="text-muted-foreground relative flex justify-center">
            <span class="bg-background flex h-5 items-center">
              <SquareTerminalIcon class={["size-3.5", failed && "text-destructive"]} />
            </span>
          </div>
          <PlatformNotice
            summary={{ label: `${notice.label} ${noticeSentence(notice)}`, failed }}
            at={row.at}
            details={runnerNoticeDetails(row.event)}
            open={expanded.has(`${row.key}:details`)}
            ontoggle={(open) => toggle(`${row.key}:details`, open)}
          >
            {#snippet actions()}
              {#if backgroundJobs?.knows(notice.id)}
                <Button variant="ghost" size="xs" class="-my-0.5 h-5" onclick={() => backgroundJobs.open(notice.id)}>
                  <SquareTerminalIcon data-icon="inline-start" />
                  Show output
                </Button>
              {/if}
            {/snippet}
          </PlatformNotice>
        {:else if row.kind === "subagent"}
          {@const notice = row.notice}
          {@const ended = endLabel(notice.reason)}
          <div class="text-muted-foreground relative flex justify-center">
            <span class="bg-background flex h-5 items-center">
              <BotIcon class={["size-3.5", ended.tone === "failed" && "text-destructive"]} />
            </span>
          </div>
          <PlatformNotice
            summary={{ label: `Subagent ${notice.label} ${ended.label.toLowerCase()} after ${formatElapsed(notice.durationMs)}`, failed: ended.tone === "failed" }}
            at={row.at}
            details={runnerNoticeDetails(row.event)}
            open={expanded.has(`${row.key}:details`)}
            ontoggle={(open) => toggle(`${row.key}:details`, open)}
          >
            {#snippet actions()}
              {#if subagents}
                <Button variant="ghost" size="xs" class="-my-0.5 h-5" onclick={() => subagents.open(notice.id)}>
                  <BotIcon data-icon="inline-start" />
                  Show subagent
                </Button>
              {/if}
            {/snippet}
          </PlatformNotice>
        {:else if row.kind === "skills"}
          <div class="text-muted-foreground relative flex justify-center">
            <span class="bg-background flex py-1">
              <BookOpenTextIcon class="size-3.5" />
            </span>
          </div>
          <!-- The detail names repo paths and RIDs that do not break on their own, so it may break
               anywhere, and on a narrow screen it goes under the label rather than into the sliver
               beside it. -->
          <div class="flex items-baseline gap-2 py-0.5 text-xs">
            <div class="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
              <span class="font-medium sm:shrink-0">
                {row.what === "dropped" ? "Skills left out" : "Org skills behind the repository"}
              </span>
              {#if row.what === "dropped"}
                <ul class="text-muted-foreground flex min-w-0 flex-col wrap-anywhere">
                  {#each row.detail.split("\n").filter((line) => line.trim() !== "").map(
                    parseSkillDrop,
                  ) as drop, i (i)}
                    <li>
                      {#if drop.where === null}
                        {drop.reason}
                      {:else}
                        <span class="text-foreground font-mono">{drop.name}</span>
                        ({drop.where}): {drop.reason}
                      {/if}
                    </li>
                  {/each}
                </ul>
              {:else if skills?.org}
                <span class="text-muted-foreground min-w-0 wrap-anywhere">
                  The latest sync failed, so the run got
                  <ForgeRepoLabel repoRef={skills.org.repoRef} /> at
                  <span class="font-mono" title={skills.org.commit}>{shortCommit(skills.org.commit)}</span>,
                  synced {formatRelativeTime(skills.org.syncedAt)}.
                </span>
              {:else}
                <span class="text-muted-foreground min-w-0">
                  The latest sync failed, so the run got the last synced skills.
                </span>
              {/if}
            </div>
            <span class="text-muted-foreground shrink-0 pr-2">{formatTime(row.at)}</span>
          </div>
        {:else if row.kind === "tool" && row.call.view.kind === "chat"}
          <!-- The agent's side of the chat, drawn as what it said there rather than as a tool
               call: the conversation reads both ways, and the call's plumbing (its name, the
               "Posted." it got back) says nothing a reader needs. Tinted apart from the messages
               it answers, which are said TO the run. -->
          <div class="relative flex justify-center">
            {@render face()}
          </div>
          <div
            class="bg-primary/10 -mx-(--card-spacing) flex min-w-0 flex-col gap-2 rounded-xl px-(--card-spacing) py-2 [--card-spacing:--spacing(2)]"
          >
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium">{agentName}</span>
              <span class="text-muted-foreground text-xs">in chat</span>
              {#if !row.call.done}
                <Spinner class="text-muted-foreground size-3" />
              {/if}
              <span class="text-muted-foreground ml-auto pr-2 text-xs">{formatTime(row.at)}</span>
            </div>
            <Markdown content={row.call.view.text} imageRunId={history.runId ?? undefined} />
            {#if row.call.isError}
              <p class="text-destructive text-xs">
                Not posted{row.call.resultText ? `: ${row.call.resultText}` : "."}
              </p>
            {/if}
          </div>
        {:else if row.kind === "tool"}
          {@const ToolIcon = presentationFor(
            row.call,
            row.call.view.kind === "read" ? skillRead(row.call.view.path, runSkills?.() ?? null) : null,
          ).icon}
          <div class="text-muted-foreground relative flex justify-center">
            <span class="bg-background flex pt-2.5 pb-1"><ToolIcon class="size-3.5" /></span>
          </div>
          <div class="min-w-0">
            <!-- `open` is held by the history, not by the row: a row that scrolls out of the
                 window is unmounted, and a call that was open must still be open when the reader
                 scrolls back to it. -->
            <ToolCallView
              call={row.call}
              open={expanded.has(row.key)}
              ontoggle={(open) => toggle(row.key, open)}
            />
          </div>
        {:else if row.kind === "event" && row.event.kind === "inbound" && runnerNoticeSummary(row.event.payload) !== null}
          {@const summary = runnerNoticeSummary(row.event.payload)!}
          <div class="text-muted-foreground relative flex justify-center">
            <span class="bg-background flex h-5 items-center">
              {#if summary.checksState}
                <CheckStateIcon state={summary.checksState} class="size-3.5" />
              {:else}
                <MessageSquareIcon class={["size-3.5", summary.failed && "text-destructive"]} />
              {/if}
            </span>
          </div>
          <PlatformNotice
            {summary}
            at={row.at}
            details={runnerNoticeDetails(row.event)}
            open={expanded.has(`${row.key}:details`)}
            ontoggle={(open) => toggle(`${row.key}:details`, open)}
          >
            {#snippet actions()}
              {#each inboxNoticeActions(runnerChecksPayload(row.event.payload)) as action (action.label)}
                <Button variant="ghost" size="xs" class="-my-0.5 h-5" href={action.href}>
                  {action.label}
                </Button>
              {/each}
            {/snippet}
          </PlatformNotice>
        {:else if row.kind === "message" && isInboxNotice(row.message)}
          {@const message = row.message}
          {@const held = heldNotice(message)}
          {@const summary = inboxNoticeSummary(message.payload)}
          <div class="text-muted-foreground relative flex justify-center">
            <span class="bg-background flex h-5 items-center">
              {#if summary.checksState}
                <CheckStateIcon state={summary.checksState} class="size-3.5" />
              {:else}
                <MessageSquareIcon class={["size-3.5", summary.failed && "text-destructive"]} />
              {/if}
            </span>
          </div>
          <PlatformNotice
            summary={{ ...summary,
              label: message.payload?.kind === "finish" ? `${senderLabel(message)} ${summary.label}` : held && !held.held ? HOOK_NOTICE_PAST_LABEL : summary.label,
              detail: held && !held.held ? [summary.detail, held.line].filter(Boolean).join(" · ") : summary.detail,
              failed: held ? held.held !== null : summary.failed,
            }}
            at={row.at}
            details={message.text}
            open={expanded.has(`${row.key}:details`)}
            ontoggle={(open) => toggle(`${row.key}:details`, open)}
          >
            {#snippet actions()}
              {#each inboxNoticeActions(message.payload) as action (action.label)}
                <Button
                  variant="ghost"
                  size="xs"
                  class="-my-0.5 h-5"
                  href={action.href}
                  target={action.external ? "_blank" : undefined}
                  rel={action.external ? "noopener noreferrer" : undefined}
                >
                  {action.label}
                </Button>
              {/each}
            {/snippet}
            {#if held?.held}
              <HookWarning patch={held.held} refresh={patchesRefresh} diffLink role="status" />
            {/if}
            {#if message.attachments.length > 0}
              <AttachmentImages runId={message.runId} attachments={message.attachments} />
            {/if}
          </PlatformNotice>
        {:else if row.kind === "message"}
          {@const message = row.message}
          {@const fire = message.kind === "alert" ? parseFireMessage(message.text) : null}
          {@const notice = message.kind === "system" ? heldNotice(message) : null}
          <div class="text-muted-foreground relative flex justify-center">
            <span class="bg-background flex py-1"><MessageSquareIcon class="size-3.5" /></span>
          </div>
          <!-- What was said TO the run, marked by its own surface: in a response several people
               speak into one transcript, and who said a thing is as load-bearing as what was said. -->
          <!-- Out past the column by the tool call card's own margin, so the sender lines up with
               a call's badge and the time with every other row's. -->
          <div
            class="bg-muted/60 -mx-(--card-spacing) flex min-w-0 flex-col gap-2 rounded-xl px-(--card-spacing) py-2 [--card-spacing:--spacing(2)]"
          >
            <div class="flex items-center gap-2">
              <!-- A person by their face as the sidebar draws one — initials; one the directory
                   no longer names goes by the label alone. -->
              {#if message.sender.kind === "user" && message.sender.name}
                <Avatar.Root class="size-5" aria-hidden="true">
                  <Avatar.Fallback class="bg-background text-[0.625rem]">
                    {personInitials(message.sender.name)}
                  </Avatar.Fallback>
                </Avatar.Root>
              {/if}
              <span class="text-sm font-medium">{senderLabel(message)}</span>
              {#if fire}
                {#if fire.status}
                  <Badge
                    variant={fire.status === "firing" ? "destructive" : fire.status === "resolved" ? "secondary" : "outline"}
                  >
                    {fire.status === "firing" ? "Firing" : fire.status === "resolved" ? "Resolved" : "Update"}
                  </Badge>
                {/if}
                {#if fire.number !== null}
                  <span class="text-muted-foreground text-xs">#{fire.number}</span>
                {/if}
              {:else if message.kind === "alert"}
                <Badge variant="outline">fire</Badge>
              {:else if message.kind === "system" && message.payload}
                <Badge variant={notice?.held ? "destructive" : "secondary"}>
                  {notice && !notice.held ? HOOK_NOTICE_PAST_LABEL : systemPayloadLabel(message.payload)}
                </Badge>
              {/if}
              <span class="text-muted-foreground ml-auto pr-2 text-xs">{formatTime(row.at)}</span>
            </div>
            {#if message.kind === "user" || message.kind === "chat"}
              {#if message.text !== ""}<Markdown content={message.text} />{/if}
            {:else if fire}
              <!-- What the fire is about, by the title its format read, else by each alert in an
                   Alertmanager body; the webhook's body, which is what the agent was handed,
                   behind a toggle. -->
              {#if fire.title}
                <p class="text-sm font-medium wrap-anywhere">{fire.title}</p>
              {/if}
              {#if fire.alerts.length > 0 && (fire.title === null || fire.alerts.length > 1)}
                <ul class="flex flex-col gap-1.5 text-sm">
                  {#each fire.alerts as item, i (i)}
                    <li class="flex min-w-0 flex-col wrap-anywhere">
                      <span class="font-medium">{item.name}</span>
                      {#if item.summary}
                        <span class="text-muted-foreground line-clamp-2">{item.summary}</span>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}
              <Collapsible.Root
                class="group/alert min-w-0"
                open={expanded.has(`${row.key}:body`)}
                onOpenChange={(open) => toggle(`${row.key}:body`, open)}
              >
                <Collapsible.Trigger
                  class="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
                >
                  <ChevronRightIcon
                    class="size-3 shrink-0 transition-transform group-data-[state=open]/alert:rotate-90"
                  />
                  Payload
                </Collapsible.Trigger>
                <Collapsible.Content>
                  <pre
                    class="bg-background/60 mt-2 max-h-80 overflow-auto rounded-lg p-3 font-mono text-xs">{fire.body}</pre>
                </Collapsible.Content>
              </Collapsible.Root>
            {:else if notice?.held}
              <HookWarning patch={notice.held} refresh={patchesRefresh} diffLink role="status" />
            {:else if notice}
              <p class="text-sm">{notice.line}</p>
            {:else if message.payload?.kind === "finish"}
              <!-- The badge says it all. -->
            {:else}
              <pre
                class="max-h-96 overflow-auto font-sans text-sm whitespace-pre-wrap">{message
                  .text}</pre>
            {/if}
            {#if message.attachments.length > 0}
              <AttachmentImages runId={message.runId} attachments={message.attachments} />
            {/if}
          </div>
        {:else if row.kind === "result"}
          {@const result = row.result}
          {@const failed = result.status === "failure" || result.status === "error"}
          <div class="text-muted-foreground relative flex justify-center">
            <span class="bg-background flex py-1">
              {#if failed}
                <TriangleAlertIcon class="text-destructive size-3.5" />
              {:else}
                <CircleIcon class="size-2.5" />
              {/if}
            </span>
          </div>
          <RunResult
            runId={history.runId}
            {result}
            egressNote={row.egressNote}
            limit={row.limit}
            expanded={expanded.has("result-summary")}
            ontoggle={(open) => toggle("result-summary", open)}
          />
        {:else if row.kind === "live"}
          <div class="relative flex justify-center">
            <span class="bg-background flex py-0.5">
              {#if bot}
                {@render face()}
              {:else}
                <AgentThrobber {agentId} mood={activity === "working" ? (evil ? "evil" : "working") : "sleepy"} size={28} />
              {/if}
            </span>
          </div>
          <AgentActivity {agentName} {activity} bind:evil />
        {:else if laneMarkOf(row.event) !== null}
          {@const mark = laneMarkOf(row.event)!}
          {#if mark.kind === "end"}
            {@const ended = endLabel(mark.reason)}
            <!-- The close of a stretch of work: quiet, as the machine's own lines are. -->
            <div class="text-muted-foreground relative flex justify-center">
              <span class="bg-background flex py-1">
                <FlagIcon class={["size-3.5", ended.tone === "failed" && "text-destructive"]} />
              </span>
            </div>
            <p class="text-muted-foreground flex items-baseline gap-2 py-0.5 text-xs">
              <span class={["font-medium", ended.tone === "failed" && "text-destructive"]}>
                {ended.label}
              </span>
              <span>after {formatElapsed(mark.durationMs)}</span>
              <span class="ml-auto shrink-0 pr-2">{formatTime(row.at)}</span>
            </p>
          {:else}
            <!-- What the parent handed it, said to it while it worked, or continued it with: said
                 TO the subagent, so drawn as a message is. Agent-written, so only ever text. -->
            <div class="text-muted-foreground relative flex justify-center">
              <span class="bg-background flex py-1">
                {#if mark.kind === "start"}
                  <BotIcon class="size-3.5" />
                {:else}
                  <MessageSquareIcon class="size-3.5" />
                {/if}
              </span>
            </div>
            <div
              class="bg-muted/60 -mx-(--card-spacing) flex min-w-0 flex-col gap-2 rounded-xl px-(--card-spacing) py-2 [--card-spacing:--spacing(2)]"
            >
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium">
                  {#if mark.kind === "start"}Task{:else}{parentName ?? "Parent agent"}{/if}
                </span>
                {#if mark.kind === "start"}
                  <Badge variant="outline">{modeLabel(mark.mode)}</Badge>
                {:else if mark.kind === "resume"}
                  <Badge variant="secondary">Continued</Badge>
                {/if}
                <span class="text-muted-foreground ml-auto pr-2 text-xs">{formatTime(row.at)}</span>
              </div>
              <p class="max-h-96 overflow-auto text-sm whitespace-pre-wrap wrap-anywhere">
                <bdi>{mark.kind === "start" ? mark.task : mark.message}</bdi>
              </p>
            </div>
          {/if}
        {:else if row.event.kind === "thinking"}
          {@const thought = splitThought(row.event.text ?? "")}
          <div class="text-muted-foreground relative flex justify-center">
            <span class="bg-background flex py-1"><MessageCircleDashedIcon class="size-3.5" /></span>
          </div>
          <!-- Folded to its own heading. Reasoning is most of a transcript by height and almost
               none of it by consequence: it is here for when a run went somewhere strange, not for
               the reading. A thought with nothing under its first line is not folded at all: a row
               that opens onto nothing is a worse answer than a row that does not open. -->
          {#if thought.body}
            <Collapsible.Root
              class="group/row min-w-0"
              open={expanded.has(row.key)}
              onOpenChange={(open) => toggle(row.key, open)}
            >
              <Collapsible.Trigger
                class="text-muted-foreground hover:text-foreground -ml-[1.125rem] flex w-[calc(100%+1.125rem)] items-baseline gap-1.5 text-left text-sm transition-colors"
              >
                <ChevronRightIcon
                  class="size-3 shrink-0 self-center transition-transform group-data-[state=open]/row:rotate-90"
                />
                <span class="truncate {thought.heading ? '' : 'group-data-[state=open]/row:hidden'}">
                  {thought.title}
                </span>
                {#if !thought.heading}
                  <span class="hidden group-data-[state=open]/row:inline">Thinking</span>
                {/if}
                <span class="ml-auto shrink-0 pr-2 text-xs">{formatTime(row.at)}</span>
              </Collapsible.Trigger>
              <Collapsible.Content>
                <Markdown content={thought.body} class="text-muted-foreground pt-2" />
              </Collapsible.Content>
            </Collapsible.Root>
          {:else}
            <p class="text-muted-foreground flex min-w-0 items-baseline gap-1.5 text-sm">
              <span class="truncate">{thought.title}</span>
              <span class="ml-auto shrink-0 pr-2 text-xs">{formatTime(row.at)}</span>
            </p>
          {/if}
        {:else if row.event.kind === "assistant"}
          {@const event = row.event}
          <div class="relative flex justify-center">
            {@render face()}
          </div>
          <div class="flex min-w-0 flex-col gap-1">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium">{agentName}</span>
              <span class="text-muted-foreground ml-auto pr-2 text-xs">{formatTime(row.at)}</span>
            </div>
            {#if event.text}<Markdown content={event.text} imageRunId={history.runId ?? undefined} />{/if}
          </div>
        {:else}
          {@const event = row.event}
          <div class="text-muted-foreground relative flex justify-center">
            <span class="bg-background flex py-1"><CircleIcon class="size-2.5" /></span>
          </div>
          <div class="flex min-w-0 flex-col gap-1">
            <div class="flex items-center gap-2">
              <Badge variant="secondary">{event.kind}</Badge>
              <span class="text-muted-foreground ml-auto pr-2 text-xs">{formatTime(row.at)}</span>
            </div>
            <!-- Machine metadata, so it stays literal where the model's own prose renders as the
                 markdown it is. -->
            {#if event.text}
              <pre
                class="max-h-96 overflow-auto font-sans text-sm whitespace-pre-wrap">{event
                  .text}</pre>
            {/if}
          </div>
        {/if}
      </div>
{/snippet}
