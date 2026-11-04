import { SvelteSet } from "svelte/reactivity";
import { type ContextUsage, contextUsageOf } from "$lib/components/run-context/context-usage";
import { getRunEventsBefore, type HistoryPage, type HistoryWindow } from "$lib/api/history";
import { mergeToolCalls, type ToolCall, workspaceRootOf } from "$lib/api/tools";
import type { HistoryEvent, RunEvent, RunMessage, RunnerResult } from "$lib/api/types";
import { type BackgroundNotice, backgroundNoticeOf } from "$lib/utils/background";
import { isInboxDelivery } from "$lib/utils/run-refresh";
import { type SubagentNotice, subagentNoticeOf } from "$lib/utils/subagents";
import { isPlatformInbound } from "$lib/components/run-transcript/platform-notice";

/** How many events one scroll upwards asks for. */
export const OLDER_PAGE = 200;
/**
 * How many pages may be loaded at once before the one farthest from the viewport is dropped.
 * Forty pages is ~8,000 events, which at the runner's per-event bounds is the tens of megabytes
 * this whole design exists to stop a tab from holding.
 */
export const MAX_PAGES = 40;
/** Pages this close to the viewport are never evicted, however far the reader has scrolled. */
export const KEEP_AROUND = 10;

/** The machine narrating itself: an orchestrator lifecycle event, or a harness `system` chunk. */
export interface MachineNote {
  key: string;
  at: string;
  kind: string;
  detail?: string;
}

/** The warning kind a `setup.failed` summary opens with, in brackets (orchestrator
 * core/setup_warnings.ts `describeSetupWarning`). */
const SETUP_KIND = /^\[(step|invalid|discarded|dirty|unreadable)\] /;

/** Kinds whose repo's setup finished, and only changes in its tree were put back. */
const SETUP_DISCARDED_KINDS = new Set(["discarded", "dirty"]);

/**
 * One row of the transcript, as the virtualiser draws it. A flat list is what a windowed list
 * needs — it mounts rows by index — so every shape a run can produce is one of these, including
 * the two that are not events at all: the gap where a page is not loaded, and the run's result.
 *
 * `key` is stable across loads because rows own UI state that is held outside them (see
 * `expanded`), and because the virtualiser keys its items by it.
 */
export type TranscriptRow =
  /** Events between two loaded pages, or above the oldest one: how many, and how to get them. */
  | { key: string; kind: "gap"; before: number; count: number; loading: boolean; failed: boolean }
  | { key: string; kind: "machine"; at: string; events: MachineNote[] }
  | { key: string; kind: "tool"; at: string; call: ToolCall }
  | { key: string; kind: "event"; at: string; event: HistoryEvent }
  | { key: string; kind: "message"; at: string; message: RunMessage }
  /** The run reached one of its limits and was asked to stop; `detail` names which. */
  | { key: string; kind: "limit"; at: string; detail: string }
  /** A repo's base came from the forge's cache while the upstream could not be reached, so
   * the run may have started behind it; `detail` names the repo, the base and since when. */
  | { key: string; kind: "stale"; at: string; detail: string }
  /** Skills the run could not be given (a name another source took, the listing cap, a bundle
   * that would not load), or org skills from a version behind the repo; `detail` says which, one
   * skill per line for drops. */
  | { key: string; kind: "skills"; at: string; what: "dropped" | "stale"; detail: string }
  /** The agent has a browser and this run started without one (the deployment runs none, its
   * provisioner cannot launch one, or the harness has no MCP client); `detail` says which. */
  | { key: string; kind: "browser"; at: string; detail: string }
  /** A response's run could not be bound to its room's conversation, so the room hears nothing
   * of it; `detail` says why ("it was busy": another run holds the conversation). */
  | { key: string; kind: "unbound"; at: string; detail: string }
  /** A repo's setup did not finish and the run went on without the rest of it. `summary` names
   * the repo and the step, its exit code, what was skipped and whether its changes to the tree
   * were discarded — or that its setup.yml was invalid; `output` is the end of what the step
   * printed, or the file's validation error, "" when there is neither. `discarded` when the
   * repo's own setup finished and only changes in its tree were put back (another repo's step
   * failed, or setup left files changed): not a setup that didn't finish. */
  | {
    key: string;
    kind: "setup";
    at: string;
    summary: string;
    output: string;
    discarded: boolean;
  }
  /** The runner telling the agent one of its background commands ended. */
  | {
    key: string;
    kind: "background";
    at: string;
    seq: number;
    notice: BackgroundNotice;
    event: HistoryEvent;
  }
  /** The runner telling the agent one of its subagents ended; the answer is in the subagent's
   * own transcript. */
  | {
    key: string;
    kind: "subagent";
    at: string;
    seq: number;
    notice: SubagentNotice;
    event: HistoryEvent;
  }
  | {
    key: string;
    kind: "result";
    result: RunnerResult;
    egressNote: string | null;
    /** The limit that ended the run, as its trail recorded it; null when none did. */
    limit: string | null;
  }
  | { key: string; kind: "live" };

/** Everything the transcript draws that does NOT come from the historian. */
export interface RunDetail {
  /** The orchestrator's own trail for this run. */
  lifecycle: readonly RunEvent[];
  /** What was said TO the run, oldest first. */
  messages: readonly RunMessage[];
  result: RunnerResult | null;
  egressNote: string | null;
  /** The run is still going: the tail may still deliver, and the newest page is pinned. */
  live: boolean;
}

const NO_DETAIL: RunDetail = {
  lifecycle: [],
  messages: [],
  result: null,
  egressNote: null,
  live: false,
};

/**
 * A loaded stretch of a run, keyed by the seq range it covers. Ranges, not one flat array: that is
 * what lets a page be dropped and its absence still be known, and what keeps a merge, a sort and a
 * row build scoped to the couple of hundred events that changed.
 */
interface Page {
  firstSeq: number;
  lastSeq: number;
  events: readonly HistoryEvent[];
  /** The start of the run. Never evicted — the workspace root lives here. */
  head: boolean;
  /** Bumped whenever `events` changes; what the row cache keys off. */
  version: number;
}

/** A detail item placed in a page, ready to be sorted in with its events. */
type Placed =
  | { at: string; row: TranscriptRow }
  | { at: string; machine: MachineNote };

/** What one page's rows were built from, so they are only built again when that changes. */
interface RowCache {
  key: string;
  rows: TranscriptRow[];
}

interface MergeCache {
  key: string;
  value: ReturnType<typeof mergeToolCalls>;
}

/** The run saying which message its summary came from: where the mark is, and what it names. */
interface Mark {
  /**
   * The seq of the marking EVENT — which mark is the run's last word is decided on the total order
   * the seq is, never on `at`: a mark and the retraction that follows it are written in the same
   * millisecond, and two timestamps that tie say nothing about which came second.
   */
  seq: number;
  /** The seq of the message to fold, or null for a mark that names nothing. */
  names: number | null;
}

const field = (payload: unknown, key: string): unknown =>
  typeof payload === "object" && payload !== null && key in payload
    ? (payload as Record<string, unknown>)[key]
    : undefined;

/**
 * The mark on an event, in either of the two spellings this has to survive: the runner's follow-up
 * `final` event naming a seq, and a `final: true` on an assistant event's own payload.
 *
 * A `final` event that names NOTHING — `seq: null`, or `superseded: true` — is a correction: the
 * run's summary turned out to come from somewhere other than a message (a run that ends through
 * the `finish` tool takes it from there), so there is nothing to fold. It still
 * counts as a mark, and as the LATER one it is the one that stands.
 */
function readMark(event: HistoryEvent): Mark | null {
  if (event.kind === "final") {
    const seq = field(event.payload, "seq");
    const superseded = field(event.payload, "superseded") === true;
    return { seq: event.seq, names: superseded || typeof seq !== "number" ? null : seq };
  }
  if (event.kind !== "assistant") return null;
  return field(event.payload, "final") === true ? { seq: event.seq, names: event.seq } : null;
}

/** Routine presentation noise only; ingestion and activity tracking still see these events. */
const ROUTINE_LIFECYCLE = new Set([
  "created",
  "launched",
  "bootstrap-redeemed",
  "first-heartbeat",
  "credentials-issued",
  "phase-changed",
  "attended",
  "result-received",
  "skills.root",
  "skills.repo",
]);
const ROUTINE_SYSTEM = new Set(["session", "agent_start", "compaction_start"]);

/**
 * The `system` rows pi narrates while the agent is NOT taking a turn. Compaction runs after a turn
 * has ended (pi checks for it on `agent_end`), so a settled agent narrates a compaction a few
 * seconds after its last word; `session` opens a run and `finished` closes one. None of them says
 * the agent has started working again — `agent_start` and a retry do, and they are not in here.
 */
const QUIET_SYSTEM = new Set([
  "session",
  "compaction_start",
  "compaction_end",
  "context_usage",
  "finished",
]);

/**
 * Whether an event is the run itself saying something — what decides whether the agent is working
 * or waiting. The diag voice is the machine narrating, a `final` is a back-reference to a message
 * already said, and a quiet `system` row is pi housekeeping between turns.
 */
function speaks(event: HistoryEvent): boolean {
  if (event.voice !== "transcript" || event.kind === "final") return false;
  return event.kind !== "system" || !QUIET_SYSTEM.has(event.text ?? "");
}

/** Whether a result has a summary to show — which is what makes folding the message that said it
 * the right thing to do. An `error` result carries no summary at all: hiding the agent's closing
 * message there would take the only account of what happened off the page. */
function summarised(result: RunnerResult | null): boolean {
  if (result === null || !("summary" in result)) return false;
  return typeof result.summary === "string" && result.summary.trim() !== "";
}

/**
 * A run's history as the page holds it: the pages that are loaded, the holes between them, and the
 * flat list of rows the transcript draws.
 *
 * ONE INSTANCE PER RUN, and the run is a constructor argument so that it cannot be otherwise: a
 * different run — a retry, or the next task the reader opens — is a different history and gets its
 * own object. It used to be one instance the page pointed at whichever run it was showing, and the
 * moment it was re-pointed the transcript drawing the old run had the new run's rows underneath it,
 * with the virtualiser still holding the old row count: it read past the end of the list and threw
 * inside a flush, which takes the whole page's rendering down with it.
 *
 * The load seeds it once (as `LiveTaskList` is seeded) and every later load then only
 * refreshes the tail and the detail: re-seeding from a load would throw away every page the reader
 * scrolled back to.
 */
export class RunHistory {
  /** Row keys whose row is open. Lifted out of the rows because a windowed row is unmounted the
   * moment it leaves the viewport, and its open state must outlive that. */
  readonly expanded = new SvelteSet<string>();
  /** Whether diagnostics and routine machine notes are drawn. The task overflow menu binds to this. */
  showDiag = $state(false);

  /** The run this history is of, for its whole life. */
  readonly #runId: string | null;
  /**
   * Whether the load's window has been taken. Every seed after the first is a refresh.
   *
   * Reactive, because the transcript panel is drawn off it: a first window that arrived without
   * its tail seeds nothing and leaves this false, which is what puts the "could not load this
   * run's history" state on screen — and the retry behind that state is a load, which seeds, which
   * has to take the state back off again.
   */
  #seeded = $state(false);
  /** Ascending by `firstSeq`, never overlapping. */
  #pages = $state.raw<Page[]>([]);
  #detail = $state.raw<RunDetail>(NO_DETAIL);
  /** Bumped by `setDetail`: what tells a page holding lifecycle rows that they may have moved. */
  #detailVersion = $state(0);
  /** Anchors (the `before` seq) with a fetch in flight, and those whose fetch failed. Reactive
   * sets: the gap row they belong to is on screen while they change. */
  readonly #inFlight = new SvelteSet<number>();
  readonly #failed = new SvelteSet<number>();

  /**
   * The marks the run has made, recorded as events arrive rather than searched for at draw time.
   * Searched for, they were only ever found on the newest page — and the runner keeps narrating
   * after the mark, so a live tail rolls to a new page and strands it, which left a `final` event
   * drawn as a junk row and the closing message said twice.
   */
  #markerSeqs = $state.raw<ReadonlySet<number>>(new Set());
  /** What the LAST mark names, or null when it names nothing. */
  #markedSeq = $state.raw<number | null>(null);
  /** The seq of the mark that was. Plain: it only decides whether a newly seen mark is later. */
  #lastMarkSeq = -1;

  /**
   * The newest event the run itself said, recorded as events land rather than searched for at
   * read time. Searched for, it was only ever looked for on the newest page — and the load's tail
   * is exactly one page's worth, so the first event the stream delivered after it started a page
   * of its own. A diag event there left nothing "said" on the newest page, and an idle agent's
   * blob flipped to working a few seconds after the page opened.
   */
  #lastSpoken = $state.raw<HistoryEvent | null>(null);

  /** Latest context snapshot survives page eviction and older-history loads. */
  contextUsage = $state.raw<ContextUsage | null>(null);
  #contextSeq = -1;

  /**
   * The seq to ask `before` from to extend the loaded region upwards, or null at the head.
   *
   * A `$derived` rather than a getter, because the live tail reassigns `#pages` on every event it
   * delivers: a getter recomputed there hands its reader a "new" answer sixty times a minute. A
   * derived that computes the same value again notifies nobody.
   */
  readonly #anchor = $derived.by((): number | null => {
    const pages = this.#pages;
    if (pages.length === 0) return null;
    const head = pages[0].head ? pages[0] : null;
    const oldest = head === null ? pages[0] : pages[1];
    if (oldest === undefined) return null; // only the head is loaded: the run starts on screen
    const covered = head?.lastSeq ?? -1;
    if (oldest.firstSeq <= covered + 1) return null;
    return oldest.firstSeq;
  });

  /** Where the reader is, in seqs — plain, not state: only eviction reads it, and a scroll that
   * re-ran the row derivation would be the stutter this exists to avoid. */
  #viewportSeq: number | null = null;

  readonly #fetch: typeof fetch;
  readonly #grant: () => string | null;
  /** Which of the run's transcripts this is: `""` for its own, `sa-<n>` for a subagent's. */
  readonly #lane: string;
  /**
   * The lowest seq the lane can hold. The run's own counts from 0 and a subagent's from 1, so an
   * event at or below this is the start of the lane, with nothing above it to draw a gap for.
   */
  readonly #firstSeq: number;
  /** The checkout, for a lane that never sees the event naming it: a subagent's. */
  readonly #rootFallback: () => string | null;

  /** Caches, per page, keyed by everything a page's rows depend on. Plain maps: they are memos of
   * a derivation, not state, and writing to them must not invalidate it. */
  readonly #merges = new Map<number, MergeCache>();
  readonly #orphanCache = new Map<number, MergeCache>();
  readonly #rows = new Map<number, RowCache>();

  constructor(
    runId: string | null,
    f: typeof fetch = fetch,
    grant: () => string | null = () => null,
    options: {
      /** One subagent's transcript rather than the run's own. */
      lane?: string;
      /** Where tool rows' paths are relative to, when the lane's own head does not say. */
      root?: () => string | null;
    } = {},
  ) {
    this.#runId = runId;
    this.#fetch = f;
    this.#grant = grant;
    this.#lane = options.lane ?? "";
    this.#firstSeq = this.#lane === "" ? 0 : 1;
    this.#rootFallback = options.root ?? (() => null);
  }

  get runId(): string | null {
    return this.#runId;
  }

  get lane(): string {
    return this.#lane;
  }

  /** The run's checkout, as its head page names it; null until that page is loaded. */
  get root(): string | null {
    return this.#root;
  }

  /**
   * Nothing has happened yet: no events, nothing said to the run, no outcome. The live row does
   * not count — a run that has only just started draws as "nothing recorded yet", not as a
   * transcript of one spinner.
   */
  get bare(): boolean {
    return this.rows.every((row) => row.kind === "live");
  }

  /** The newest seq held, which is where the live tail resumes from. */
  get lastSeq(): number {
    return this.#pages.at(-1)?.lastSeq ?? -1;
  }

  /**
   * The last thing the run itself said — what tells the page whether the agent has stopped and is
   * waiting to be spoken to. The newest such event of any page that has landed, so it holds across
   * a page boundary; see `speaks` for what counts.
   */
  get lastSpoken(): HistoryEvent | null {
    return this.#lastSpoken;
  }

  /** Whether anything above the loaded pages is still to be read. */
  get hasOlder(): boolean {
    return this.#anchor !== null;
  }

  get loadingOlder(): boolean {
    return this.#inFlight.size > 0;
  }

  /**
   * Adopt the load's window: the two ends of the run, the first time, and after that only whatever
   * the tail has since grown by. Every page the reader has scrolled back to is kept, which is what
   * lets the three-second poller re-run the load without resetting the transcript under them.
   *
   * There is no other run to adopt — a retry mints a run whose seqs restart at 0, and that is a new
   * `RunHistory`, not this one pointed somewhere else.
   */
  seed(window: HistoryWindow): void {
    if (this.#runId === null) return;
    if (!this.#seeded) {
      // A window that arrived without its TAIL is not a history to build on: the tail is the end
      // of the run, which is where the page opens and what everything else is placed against, and
      // a head seeded without it would draw a transcript that says the run stopped fifty events
      // in. Nothing is taken, this stays unseeded — so the next poll seeds it properly — and the
      // page draws the retry the window's `error` is there for.
      if (window.tail === undefined) return;
      this.#seeded = true;
      // The head may be missing on its own, and that IS seedable: a run whose first page could not
      // be read is a run whose start is not loaded, which is a gap row above the tail and a thing
      // the transcript already knows how to say. What it costs is the workspace root, so tool rows
      // show absolute paths until somebody fetches that gap.
      if (window.head !== undefined) this.#insert(window.head, true);
      // Whatever lay between the two ends, when the load found it small enough to read in one go:
      // the three pages then meet, and there is no hole to draw. Inserted in order, because a page
      // takes the range above it from what is already held.
      if (window.middle !== undefined) this.#insert(window.middle, false);
      this.#insert(window.tail, false);
      return;
    }
    // The same run, loaded again. Its tail is a fresh read of the end of the run, and the only
    // part of it this does not hold is whatever the stream missed. A re-load that came back
    // without one has nothing to add and takes nothing away: the rows the reader is looking at
    // are the rows that were true a moment ago, and they stay.
    // The small gap between the initial ends may arrive after the conversation is on screen.
    // Insert it as an older page (not live events), merging overlaps with on-demand gap reads.
    if (window.middle !== undefined) this.#insert(window.middle, false);
    for (const event of window.tail?.events ?? []) this.absorb(event);
  }

  /**
   * Whether a window has ever been taken. False after a first load whose tail did not answer,
   * which is the one state where the page has a run to show and nothing to show of it.
   */
  get seeded(): boolean {
    return this.#seeded;
  }

  /** The lifecycle trail, the inbox and the outcome, as the task detail delivers them. */
  setDetail(detail: RunDetail): void {
    this.#detail = detail;
    this.#detailVersion++;
  }

  /** An event from the live tail. Deduped by seq: replay overlap and reconnects both repeat. */
  absorb(event: HistoryEvent): void {
    const pages = this.#pages;
    const newest = pages.at(-1);
    if (newest === undefined) {
      this.#noteMarks([event]);
      const head = event.seq <= this.#firstSeq;
      this.#pages = [{
        firstSeq: head ? 0 : event.seq,
        lastSeq: event.seq,
        events: [event],
        head,
        version: 0,
      }];
      return;
    }
    // Anything at or below the newest page's end is inside a range that is already loaded, so it
    // is a repeat by definition — the tail only ever moves forwards.
    if (event.seq <= newest.lastSeq) return;
    // A page is a bounded thing, and the live tail appends for as long as the run lasts. Past a
    // page's worth, the tail starts a new one: otherwise a day-long conversation would grow one
    // page without limit, eviction would have nothing to drop, and every merge and sort this
    // class does per page would be over the whole run again.
    this.#noteMarks([event]);
    if (newest.events.length >= OLDER_PAGE) {
      this.#pages = [...pages, {
        firstSeq: event.seq,
        lastSeq: event.seq,
        events: [event],
        head: false,
        version: 0,
      }];
      // A watch that runs for a day adds pages here and nowhere else; without this the cap is only
      // ever applied to pages somebody scrolled back to.
      this.#evict();
      return;
    }
    const grown: Page = {
      ...newest,
      lastSeq: event.seq,
      events: [...newest.events, event],
      version: newest.version + 1,
    };
    this.#pages = [...pages.slice(0, -1), grown];
  }

  /**
   * Take the marks off events as they land. The last mark by its own seq is the run's last word on
   * which message its summary came from; an earlier one is a draft of it. The newest thing the run
   * said is taken off them here too, since every way an event lands comes through here.
   */
  #noteMarks(events: readonly HistoryEvent[]): void {
    let spoken = this.#lastSpoken;
    for (const event of events) {
      const context = contextUsageOf(event);
      if (context !== null && event.seq > this.#contextSeq) {
        this.#contextSeq = event.seq;
        this.contextUsage = context;
      }
      if (speaks(event) && (spoken === null || event.seq > spoken.seq)) spoken = event;
    }
    if (spoken !== this.#lastSpoken) this.#lastSpoken = spoken;
    let markers: Set<number> | null = null;
    for (const event of events) {
      const mark = readMark(event);
      if (mark === null) continue;
      if (event.kind === "final") {
        markers ??= new Set(this.#markerSeqs);
        markers.add(event.seq);
      }
      if (mark.seq >= this.#lastMarkSeq) {
        this.#lastMarkSeq = mark.seq;
        this.#markedSeq = mark.names;
      }
    }
    if (markers !== null) this.#markerSeqs = markers;
  }

  /**
   * The next page above what is loaded. A no-op at the head of the run, and while a fetch is in
   * flight — the sentinel that calls this fires on every scroll frame it is visible for.
   */
  loadOlder(): Promise<void> {
    const anchor = this.#anchor;
    if (anchor === null) return Promise.resolve();
    return this.loadGap(anchor);
  }

  /**
   * The page immediately older than `before`: the top of a gap, wherever the gap came from — the
   * stretch between the head and the tail that was never read, or a page that was evicted.
   */
  async loadGap(before: number): Promise<void> {
    const runId = this.#runId;
    if (runId === null || this.#inFlight.has(before) || !this.#isHole(before)) return;
    this.#inFlight.add(before);
    this.#failed.delete(before);
    try {
      const page = await getRunEventsBefore(
        this.#fetch,
        runId,
        before,
        OLDER_PAGE,
        this.#grant(),
        this.#lane,
      );
      // Nothing new there — an empty answer, or events another page already holds. Close the gap
      // rather than leave a row that would ask for the same answer every time it scrolled past.
      // A page that lands after the reader has left this run lands in a history nobody is drawing:
      // it belongs to that run and to no other, so there is nothing here to guard against.
      if (!this.#insert(page, false)) this.#closeGapAbove(before);
      this.#evict();
    } catch {
      this.#failed.add(before);
    } finally {
      this.#inFlight.delete(before);
    }
  }

  /**
   * Whether anything is actually missing above the page that starts at `before` — the only thing a
   * gap fetch may be asked for.
   *
   * The two rules that fetch by themselves both fire on a scroll frame, and a scroll frame is not
   * a promise that the list still looks the way it did when the rule was written down: the page
   * this anchor named may have been filled by another fetch, or widened down to meet the one above
   * it, between the frame and the call. Answering such a call would put an anchor in flight that
   * belongs to no hole — a fetch for events already held, and `loadingOlder` set over a transcript
   * with nothing left to load, which is the one thing a "Loading…" row may never say.
   */
  #isHole(before: number): boolean {
    const pages = this.#pages;
    const at = pages.findIndex((page) => page.firstSeq === before);
    if (at === -1) return false;
    return before > (pages[at - 1]?.lastSeq ?? -1) + 1;
  }

  /** Where the reader is, as the seq of the topmost row on screen. Drives eviction, nothing else. */
  noteViewport(seq: number): void {
    this.#viewportSeq = seq;
  }

  toggle(key: string): void {
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
  }

  /** The flat list the virtualiser draws. */
  get rows(): TranscriptRow[] {
    return this.#materialised;
  }

  // ---- loading ----

  /** A page from the wire, placed among the ones already held. False when it held nothing new. */
  #insert(page: HistoryPage, head: boolean): boolean {
    const pages = this.#pages;
    // Overlap is normal: on a short run the head page and the tail page are the same events, and a
    // `before` page can meet a range that the tail has since grown into. A seq is held once.
    const covered = (seq: number) => pages.some((p) => seq >= p.firstSeq && seq <= p.lastSeq);
    const events = page.events.filter((event) => !covered(event.seq));
    if (events.length === 0) return false;
    // `hasMore` false on a backwards read means this page reached back as far as there is to go,
    // so its range runs down to whatever is already loaded above it — there is no gap to draw
    // there, or to fetch. The head page says the same thing by construction.
    const floor = pages.filter((p) => p.lastSeq < events[0].seq).at(-1);
    const firstSeq = head || !page.hasMore ? (floor?.lastSeq ?? -1) + 1 : events[0].seq;
    const placed: Page = {
      firstSeq,
      lastSeq: events[events.length - 1].seq,
      events,
      head: firstSeq === 0,
      version: 0,
    };
    this.#noteMarks(events);
    // A page that lands where an evicted one used to start must not be handed its memos.
    this.#forget(firstSeq);
    this.#pages = [...pages, placed].sort((a, b) => a.firstSeq - b.firstSeq);
    return true;
  }

  /**
   * Nothing lies between the page starting at `before` and the one above it. Widen the lower page
   * down to meet it, which is what makes the hole stop being a hole.
   */
  #closeGapAbove(before: number): void {
    const pages = this.#pages;
    const at = pages.findIndex((page) => page.firstSeq === before);
    if (at === -1) return;
    const above = pages[at - 1];
    const widened: Page = {
      ...pages[at],
      firstSeq: above === undefined ? 0 : above.lastSeq + 1,
      head: above === undefined ? true : pages[at].head,
    };
    // The caches are keyed by `firstSeq`, and this page's has just moved: what is filed under the
    // old one describes this page and would be handed to whatever page starts there next.
    this.#forget(before);
    this.#pages = [...pages.slice(0, at), widened, ...pages.slice(at + 1)];
  }

  /** Drop every memo filed under a page's range. */
  #forget(firstSeq: number): void {
    this.#merges.delete(firstSeq);
    this.#orphanCache.delete(firstSeq);
    this.#rows.delete(firstSeq);
  }

  /**
   * Drop the page farthest from the viewport once too many are held. The head page never goes (the
   * workspace root lives there), and neither does the newest — the tail appends to it while the run
   * is live, and once it is over that page is still both where the reader came in and the only one
   * whose absence a gap row could not describe: every gap is the hole BETWEEN two loaded pages, so
   * the end of the run has to stay loaded for the rest of it to be fetchable. That is one page
   * more than a plain window would keep, and it is what keeps the gap row's one shape honest.
   * Nothing within `KEEP_AROUND` pages of the viewport goes either, so a reader who scrolls back
   * down finds what they just read still loaded.
   */
  #evict(): void {
    while (this.#pages.length > MAX_PAGES) {
      const pages = this.#pages;
      const here = this.#viewportPage(pages);
      let victim = -1;
      let farthest = KEEP_AROUND;
      for (let i = 0; i < pages.length; i++) {
        if (pages[i].head) continue;
        if (i === pages.length - 1) continue;
        const distance = Math.abs(i - here);
        if (distance > farthest) {
          farthest = distance;
          victim = i;
        }
      }
      if (victim === -1) return; // everything held is near the viewport, or pinned
      this.#forget(pages[victim].firstSeq);
      this.#pages = [...pages.slice(0, victim), ...pages.slice(victim + 1)];
    }
  }

  /** Which page the reader is in. A page opens at its tail, so that is the default. */
  #viewportPage(pages: readonly Page[]): number {
    const seq = this.#viewportSeq;
    if (seq === null) return pages.length - 1;
    for (let i = 0; i < pages.length; i++) {
      if (seq <= pages[i].lastSeq) return i;
    }
    return pages.length - 1;
  }

  // ---- rows ----

  /**
   * The run's checkout, read off the head page. Every page's tool rows relativise their paths
   * against it, and only the head page has ever seen the event that names it — which is the whole
   * reason the load reads the head at all.
   */
  readonly #root = $derived.by(() => {
    const head = this.#pages[0];
    const own = head?.head === true ? workspaceRootOf(head.events) : null;
    return own ?? this.#rootFallback();
  });

  /**
   * The message the result's summary was taken off, which the result row says instead — or null,
   * for a run that marked nothing, a mark that was superseded, or a result with no summary to be
   * a duplicate of (an `error` carries none, and hiding the agent's last words there would take
   * the only account of what happened off the page).
   */
  readonly #foldedSeq = $derived.by(() => summarised(this.#detail.result) ? this.#markedSeq : null);

  readonly #materialised = $derived.by((): TranscriptRow[] => {
    const pages = this.#pages;
    const detail = this.#detail;
    const placed = this.#placeDetail(pages);
    const out: TranscriptRow[] = [];

    if (pages.length === 0) {
      // A run with no history at all still has a story: it was created, it was launched, it is
      // waiting for an environment, somebody has already spoken to it. Those arrive with the task
      // detail and have no page to be placed in, so they are their own stretch of the transcript —
      // without this a queued run read as "Nothing recorded yet" while its trail sat unused, and a
      // run that died before the runner started showed its result row with nothing above it.
      out.push(...this.#group(placed.get(0) ?? []));
    }
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const above = i === 0 ? null : pages[i - 1];
      const missing = (above?.lastSeq ?? -1) + 1;
      if (page.firstSeq > missing) {
        out.push({
          key: `gap-${page.firstSeq}`,
          kind: "gap",
          before: page.firstSeq,
          count: page.firstSeq - missing,
          loading: this.#inFlight.has(page.firstSeq),
          failed: this.#failed.has(page.firstSeq),
        });
      }
      out.push(...this.#pageRows(i, pages, placed.get(i) ?? []));
    }

    if (detail.result !== null) {
      // The outcome, as the last thing that happened — which is what it is. It used to sit in a
      // callout above the tabs, where the end of the run was read before the run.
      out.push({
        key: "result",
        kind: "result",
        result: detail.result,
        egressNote: detail.egressNote,
        limit: detail.lifecycle.findLast((e) => e.kind === "limit-reached")?.detail ?? null,
      });
    }
    if (detail.live) out.push({ key: "live", kind: "live" });
    return out;
  });

  /**
   * Lifecycle events and inbox messages into the page whose stretch of time they fall in. They
   * arrive whole with the task detail and are small, so this is a placement rather than a merge:
   * the sort that puts them among a page's events runs once per page, when that page's rows are
   * built, and not once per frame over the whole run.
   */
  #placeDetail(pages: readonly Page[]): Map<number, Placed[]> {
    const out = new Map<number, Placed[]>();
    const starts = pages.map((page) => page.events[0]?.at ?? "");
    // The last page that had already started when the item happened. An item inside a gap lands at
    // the end of the page above it, which is where it belongs in time and keeps it on screen.
    const placeAt = (at: string): number => {
      let index = 0;
      for (let i = 1; i < starts.length; i++) {
        if (starts[i] !== "" && starts[i] <= at) index = i;
      }
      return index;
    };
    const push = (at: string, item: Placed) => {
      const index = placeAt(at);
      const held = out.get(index);
      if (held === undefined) out.set(index, [item]);
      else held.push(item);
    };

    const detail = this.#detail;
    const showDiag = this.showDiag;
    detail.lifecycle.forEach((event, i) => {
      if (!showDiag && ROUTINE_LIFECYCLE.has(event.kind)) return;
      // Patch submissions are presented by their platform inbox notice, not the raw forge ref.
      if (event.kind === "patch-submitted") return;
      // A reached limit is its own row, never folded among the grey run events: it is the one
      // thing in the trail that explains why the run ended, and a reader must not have to open
      // a collapsed list to find it.
      if (event.kind === "limit-reached") {
        push(event.at, {
          at: event.at,
          row: { key: `l${i}-limit`, kind: "limit", at: event.at, detail: event.detail ?? "" },
        });
        return;
      }
      // A base served from the cache is its own row for the same reason: it changes what every
      // patch of the run was built on, and the reader deciding whether to merge must see it.
      if (event.kind === "base-stale") {
        push(event.at, {
          at: event.at,
          row: { key: `l${i}-stale`, kind: "stale", at: event.at, detail: event.detail ?? "" },
        });
        return;
      }
      // A skill the run lost, or org skills behind the repo, explain how the agent behaved: a reader
      // asking why it ignored a skill must find the answer without opening the grey events.
      if (event.kind === "skills.dropped" || event.kind === "skills.stale") {
        push(event.at, {
          at: event.at,
          row: {
            key: `l${i}-skills`,
            kind: "skills",
            at: event.at,
            what: event.kind === "skills.dropped" ? "dropped" : "stale",
            detail: event.detail ?? "",
          },
        });
        return;
      }
      // An agent with a browser that got none explains a run that never browsed, and a reader
      // looking for the browser must find why without opening the grey events.
      if (event.kind === "browser.unavailable") {
        push(event.at, {
          at: event.at,
          row: { key: `l${i}-browser`, kind: "browser", at: event.at, detail: event.detail ?? "" },
        });
        return;
      }
      // A run its room never heard of explains a silent conversation, and a reader looking for
      // the run's posts there must find why without opening the grey events.
      if (event.kind === "chat.unbound") {
        push(event.at, {
          at: event.at,
          row: { key: `l${i}-unbound`, kind: "unbound", at: event.at, detail: event.detail ?? "" },
        });
        return;
      }
      // A setup that did not finish explains an agent working on a half-prepared machine, and
      // is the warning a reader must not have to open the grey events to find.
      if (event.kind === "setup.failed") {
        const detail = event.detail ?? "";
        const cut = detail.indexOf("\n");
        const line = cut < 0 ? detail : detail.slice(0, cut);
        const tagged = SETUP_KIND.exec(line);
        const summary = tagged === null ? line : line.slice(tagged[0].length);
        push(event.at, {
          at: event.at,
          row: {
            key: `l${i}-setup`,
            kind: "setup",
            at: event.at,
            summary,
            output: cut < 0 ? "" : detail.slice(cut + 1),
            discarded: tagged !== null && SETUP_DISCARDED_KINDS.has(tagged[1]),
          },
        });
        return;
      }
      push(event.at, {
        at: event.at,
        machine: {
          key: `l${i}-${event.kind}`,
          at: event.at,
          kind: event.kind,
          detail: event.detail,
        },
      });
    });
    for (const message of detail.messages) {
      push(message.createdAt, {
        at: message.createdAt,
        row: { key: `m${message.seq}`, kind: "message", at: message.createdAt, message },
      });
    }
    return out;
  }

  /** One page's rows, built once per change to that page rather than once per frame. */
  #pageRows(index: number, pages: readonly Page[], placed: readonly Placed[]): TranscriptRow[] {
    const page = pages[index];
    const above = index === 0 ? null : pages[index - 1];
    const below = pages[index + 1] ?? null;
    const adjacentAbove = above !== null && above.lastSeq + 1 === page.firstSeq ? above : null;
    const adjacentBelow = below !== null && page.lastSeq + 1 === below.firstSeq ? below : null;
    const root = this.#root;

    const key = [
      page.version,
      root ?? "",
      this.showDiag,
      adjacentAbove?.version ?? "-",
      adjacentBelow?.version ?? "-",
      placed.length === 0 ? "-" : `${this.#detailVersion}:${placed.length}`,
      this.#foldedSeq ?? "-",
      this.#markerSeqs.size,
      this.#detail.result === null ? "-" : "r",
    ].join("|");
    const cached = this.#rows.get(page.firstSeq);
    if (cached !== undefined && cached.key === key) return cached.rows;

    const merged = this.#merge(page, adjacentBelow, root);
    // A result at the top of this page belongs to a call in the page above it, and that page's
    // merge is what decided whether it was folded in. Hidden here, drawn there.
    const foldedAbove = adjacentAbove === null
      ? null
      : this.#merge(adjacentAbove, page, root).absorbed;

    const items: Placed[] = [];
    for (const event of page.events) {
      // The marker is machinery and never a row, wherever it sits and whatever it named.
      if (this.#markerSeqs.has(event.seq)) continue;
      if (event.seq === this.#foldedSeq) continue;
      if (!this.showDiag && event.voice !== "transcript") continue;
      // Empty turn endings have nothing to display, including no avatar, timestamp or row gap.
      if (event.kind === "assistant" && !event.text?.trim()) continue;
      // What the agent was handed for an inbox message (a chat, an alert, a follow-up): the
      // message itself, framed in the runner's warnings. The message is already a row of its own,
      // drawn as who said what. A wake-up the agent asked for is minted by the runner and is in
      // no inbox, so it has no `seq` and stays: this row is the only place it shows.
      if (event.kind === "inbound" && isInboxDelivery(event.payload)) continue;
      const call = merged.calls.get(event.seq);
      if (call !== undefined) {
        // Outcome reporting is bookkeeping, not conversation. Filter after merging so its
        // paired result stays absorbed (including across pages); failures still need attention.
        if (
          !this.showDiag && !call.isError && call.view.kind === "mcp" &&
          call.view.server === "ryph" && call.view.tool === "report_outcome"
        ) continue;
        items.push({
          at: event.at,
          row: { key: `t${event.seq}`, kind: "tool", at: event.at, call },
        });
        continue;
      }
      if (event.kind === "tool_result") {
        if (merged.absorbed.has(event.seq)) continue;
        if (foldedAbove?.has(event.seq)) continue;
      }
      // A background command's end, as the runner told the agent: one line, naming the job.
      const platformInbound = event.kind === "inbound" && isPlatformInbound(event.payload);
      const notice = platformInbound ? backgroundNoticeOf(event.payload) : null;
      if (notice !== null) {
        items.push({
          at: event.at,
          row: {
            key: `h${event.seq}`,
            kind: "background",
            at: event.at,
            seq: event.seq,
            notice,
            event,
          },
        });
        continue;
      }
      // A subagent's end, as the runner told the agent: one line, naming the subagent.
      const ended = platformInbound ? subagentNoticeOf(event.payload) : null;
      if (ended !== null) {
        items.push({
          at: event.at,
          row: {
            key: `h${event.seq}`,
            kind: "subagent",
            at: event.at,
            seq: event.seq,
            notice: ended,
            event,
          },
        });
        continue;
      }
      if (event.kind === "system") {
        // Context snapshots update the masthead, not the conversation or activity indicator.
        if (event.text === "context_usage") continue;
        if (!this.showDiag && event.voice === "transcript") {
          if (ROUTINE_SYSTEM.has(event.text ?? "")) continue;
          if (
            event.text === "compaction_end" &&
            !field(event.payload, "errorMessage") && field(event.payload, "aborted") !== true
          ) continue;
        }
        items.push({
          at: event.at,
          machine: { key: `h${event.seq}`, at: event.at, kind: event.text ?? "system" },
        });
        continue;
      }
      items.push({
        at: event.at,
        row: { key: `h${event.seq}`, kind: "event", at: event.at, event },
      });
    }
    items.push(...placed);
    const rows = this.#group(items);
    this.#rows.set(page.firstSeq, { key, rows });
    return rows;
  }

  /**
   * A stretch of the transcript, in order and with the machine's own narration folded.
   *
   * Two clocks meet in the sort — the runner's and the orchestrator's — so ordering across sources
   * is approximate; each source is internally ordered already and sort stability preserves that.
   * Runs of the machine talking about itself then collapse into one row: a run opens with eight of
   * them, and at full weight that is the first screen of every transcript spent on booting up.
   */
  #group(items: readonly Placed[]): TranscriptRow[] {
    const sorted = [...items].sort((a, b) => a.at.localeCompare(b.at));
    const rows: TranscriptRow[] = [];
    for (const item of sorted) {
      if (!("machine" in item)) {
        rows.push(item.row);
        continue;
      }
      const last = rows.at(-1);
      if (last?.kind === "machine") last.events.push(item.machine);
      else {
        rows.push({ key: item.machine.key, kind: "machine", at: item.at, events: [item.machine] });
      }
    }
    return rows;
  }

  /**
   * A page's calls, folded with whatever the page below it is holding for it.
   *
   * The merge that has just gone stale is handed back in as `previous`, so a call the live tail did
   * not touch comes out as the SAME OBJECT it was. Every event on the newest page bumps its version
   * and re-merges it, and a row drawing an equal-but-new call rebuilds its syntax highlighting —
   * which is a card flashing back to plain text, and the page scrolling against the dip.
   */
  #merge(page: Page, below: Page | null, root: string | null) {
    const carried = below === null ? [] : this.#orphans(below, root);
    const key = `${page.version}|${root ?? ""}|${below?.version ?? "-"}`;
    const cached = this.#merges.get(page.firstSeq);
    if (cached !== undefined && cached.key === key) return cached.value;
    const value = mergeToolCalls(page.events, { root, carried, previous: cached?.value });
    this.#merges.set(page.firstSeq, { key, value });
    return value;
  }

  /**
   * The results a page holds for the page above it: a `tool_result` whose `tool_use` it does not
   * have. Cached apart from the page's own merge, because the page above asks for this BEFORE the
   * page has been merged itself and would otherwise re-scan it on every frame of a live tail.
   */
  #orphans(page: Page, root: string | null): readonly HistoryEvent[] {
    const key = `${page.version}|${root ?? ""}`;
    const cached = this.#orphanCache.get(page.firstSeq);
    if (cached !== undefined && cached.key === key) return cached.value.orphanResults;
    const value = mergeToolCalls(page.events, { root });
    this.#orphanCache.set(page.firstSeq, { key, value });
    return value.orphanResults;
  }
}
