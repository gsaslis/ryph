import { z } from "zod";
import { apiCall } from "./call";
import { whileVisible } from "./visible-stream";
import { type HistoryEvent, historyEventSchema } from "./types";

/**
 * One page of a run's history, exactly as the historian answered it: ascending by seq whichever
 * direction it was read in, with the range it covers and whether the direction it was read in has
 * more beyond it.
 *
 * `firstSeq`/`lastSeq` are the page's OWN range, and an empty page reports the cursor it was asked
 * from — which is what makes "where does the next page start" answerable without looking at the
 * events.
 */
export interface HistoryPage {
  events: HistoryEvent[];
  firstSeq: number;
  lastSeq: number;
  /** In the direction of travel: forwards it means newer events remain, backwards older ones. */
  hasMore: boolean;
}

/**
 * The two ends of a run the load reads: its newest page, and the first events of it.
 *
 * The head is not there to be read — fifty events of a run booting up — it is there because
 * `mergeToolCalls` relativises paths against the `workspace.created` event the runner emits first
 * of all, and a page that starts at the tail has never seen it.
 */
export interface HistoryWindow {
  /**
   * Absent when the read for it did not answer — see `error`. A page that failed is left OUT of
   * the window rather than faked as empty: an empty head says "this run starts here", which is a
   * claim, and the difference between a run with nothing in it and a run nobody could read is the
   * whole of what the page has to say about it.
   */
  head?: HistoryPage;
  /**
   * Everything between the two ends, for a run whose hole is small enough to read in one go. A
   * short run's two pages are a few dozen ROWS once the diag voice is filtered out, so the hole
   * between them lands on the first screen — and a gap row that is on screen the moment the page
   * opens has no business existing: it fetched itself immediately and flashed on the way past.
   *
   * Absent on a longer run, whose gap sits screens above the viewport and is fetched by the reader
   * scrolling to it.
   */
  middle?: HistoryPage;
  tail?: HistoryPage;
  /**
   * What went wrong with one of the reads above, when one of them did. The window is then whatever
   * DID answer, and the page draws a retry over it rather than an error screen: this load re-runs
   * every three seconds on a live run, so a single 503 from a gateway that was replacing a pod
   * used to take the whole page down between one poll and the next one succeeding.
   */
  error?: string;
}

const pageSchema = z.object({
  events: z.array(historyEventSchema),
  // Defaulted, because it is the newer half of the contract: a historian that predates backwards
  // paging answers a forwards page without it, and a page that carries events knows its own first
  // seq anyway (below). The default only ever stands for an empty page, where the cursor asked for
  // is the honest answer and -1 is the honest fallback.
  firstSeq: z.number().default(-1),
  lastSeq: z.number(),
  hasMore: z.boolean().default(false),
});

/**
 * A page from the route, with its range taken from the events themselves wherever there are any.
 * The server reports the same numbers; deriving them here is what keeps the range and the events
 * from ever disagreeing — a page's range must describe what it actually carries, because
 * `RunHistory` keys by it.
 */
/** The run's grant, appended to a query that already starts with `?`. */
function withGrant(query: string, grant: string | null | undefined): string {
  return grant ? `${query}&grant=${encodeURIComponent(grant)}` : query;
}

/** The lane, appended to a query that already starts with `?`. The run's own is never named, so
 * its reads are the same requests they always were. */
function withLane(query: string, lane: string): string {
  return lane === "" ? query : `${query}&lane=${encodeURIComponent(lane)}`;
}

async function readPage(
  f: typeof fetch,
  runId: string,
  query: string,
  grant: string | null | undefined,
  lane: string,
): Promise<HistoryPage> {
  const page = pageSchema.parse(
    await apiCall(
      f,
      `/v1/runs/${encodeURIComponent(runId)}/events${withGrant(withLane(query, lane), grant)}`,
    ),
  );
  const first = page.events[0];
  const last = page.events.at(-1);
  return {
    events: page.events,
    firstSeq: first?.seq ?? page.firstSeq,
    lastSeq: last?.seq ?? page.lastSeq,
    hasMore: page.hasMore,
  };
}

/**
 * The newest `limit` events of a run. "The newest" is spelled as a backwards page from past the
 * end of every possible seq, because the route's one cursor is a seq and there is no seq for
 * "the end" — `before` is exclusive, so the largest integer anything here can hold excludes
 * nothing.
 *
 * This is where the task page starts reading, and on a long run it is all it reads: the rest is
 * fetched as somebody scrolls back into it.
 */
export function getRunTail(
  f = fetch,
  runId: string,
  limit: number,
  grant?: string | null,
  lane = "",
): Promise<HistoryPage> {
  return readPage(f, runId, `?before=${Number.MAX_SAFE_INTEGER}&limit=${limit}`, grant, lane);
}

/** The first `limit` events of a run — the workspace root, and the run starting up. */
export function getRunHead(
  f = fetch,
  runId: string,
  limit: number,
  grant?: string | null,
  lane = "",
): Promise<HistoryPage> {
  return readPage(f, runId, `?after=-1&limit=${limit}`, grant, lane);
}

/** The `limit` events immediately older than `before` (exclusive), ascending. */
export function getRunEventsBefore(
  f = fetch,
  runId: string,
  before: number,
  limit: number,
  grant?: string | null,
  lane = "",
): Promise<HistoryPage> {
  return readPage(f, runId, `?before=${before}&limit=${limit}`, grant, lane);
}

/** The `limit` events immediately newer than `after` (exclusive), ascending. */
export function getRunEventsAfter(
  f = fetch,
  runId: string,
  after: number,
  limit: number,
  grant?: string | null,
  lane = "",
): Promise<HistoryPage> {
  return readPage(f, runId, `?after=${after}&limit=${limit}`, grant, lane);
}

/**
 * One of a run's subagents, as the historian lists it: the event that opened its lane, the latest
 * one that continued it and the latest one that closed it.
 */
export interface LaneSummary {
  /** `sa-<n>`. */
  lane: string;
  /** Its `subagent.start`. */
  start: HistoryEvent;
  /** Its latest `subagent.resume`; null when it was never continued. */
  resume: HistoryEvent | null;
  /** Its latest `subagent.end`; null while its first stretch runs. */
  end: HistoryEvent | null;
  /** How long it has worked in all: every ended stretch, not the one running now. */
  ranMs: number;
}

const laneSummarySchema = z.object({
  lane: z.string(),
  start: historyEventSchema,
  resume: historyEventSchema.nullable(),
  end: historyEventSchema.nullable(),
  ranMs: z.number().nonnegative(),
});
const lanesSchema = z.object({ lanes: z.array(laneSummarySchema) });

/** The run's subagents, in the order they were started. The run's own transcript is not one. */
export async function getRunLanes(
  f = fetch,
  runId: string,
  grant?: string | null,
): Promise<LaneSummary[]> {
  const query = grant ? `?grant=${encodeURIComponent(grant)}` : "";
  const body = lanesSchema.parse(
    await apiCall(f, `/v1/runs/${encodeURIComponent(runId)}/lanes${query}`),
  );
  return body.lanes;
}

export interface RunEventsSubscription {
  close(): void;
}

/**
 * Live-tails a run's history over SSE through the same-origin proxy (cookies ride along;
 * EventSource cannot carry a bearer). Dedup by seq is the caller's job — replay overlap and
 * browser auto-reconnect both make repeats normal. `onDone` fires when the historian closes
 * a concluded run's stream.
 */
export function subscribeRunEvents(
  runId: string,
  opts: {
    after?: number;
    /** The run's history grant, which the proxy forwards with the query. */
    grant?: string | null;
    /** Which of the run's transcripts: its own (the default) or a subagent's. */
    lane?: string;
    onEvent(event: HistoryEvent): void;
    onDone?(): void;
    onError?(): void;
  },
): RunEventsSubscription {
  // The newest seq handed to `onEvent`: where a reopen resumes. A fresh EventSource has no
  // Last-Event-ID to present, so the cursor goes in the query instead.
  let after = opts.after;
  const url = () => {
    const query = new URLSearchParams();
    if (after !== undefined) query.set("after", String(after));
    if (opts.lane) query.set("lane", opts.lane);
    if (opts.grant) query.set("grant", opts.grant);
    const suffix = query.size === 0 ? "" : `?${query}`;
    return `/api/v1/runs/${encodeURIComponent(runId)}/events/stream${suffix}`;
  };
  // Closed while the tab is hidden, and reopened from the last event delivered when it is back.
  const close = whileVisible(() => {
    const source = new EventSource(url());
    source.addEventListener("history", (e) => {
      let event: HistoryEvent;
      try {
        event = historyEventSchema.parse(JSON.parse((e as MessageEvent).data));
      } catch {
        // A malformed frame is dropped; the paginated GET remains the source of truth.
        return;
      }
      if (after === undefined || event.seq > after) after = event.seq;
      opts.onEvent(event);
    });
    source.addEventListener("done", () => {
      close();
      opts.onDone?.();
    });
    source.addEventListener("error", () => {
      // EventSource retries transient failures itself (re-presenting Last-Event-ID); a CLOSED
      // source is permanent — hand off to the caller's fallback.
      if (source.readyState === EventSource.CLOSED) opts.onError?.();
    });
    return () => source.close();
  });
  return { close };
}

/**
 * Follows a run's subagents live over SSE through the same-origin proxy: every lane as it stands
 * when the stream opens, then a lane again each time it starts, is continued or ends. A summary
 * replaces whatever the caller held for its lane, so a repeat on reconnect is harmless. `onDone`
 * fires when the historian closes a concluded run's stream.
 */
export function subscribeRunLanes(
  runId: string,
  opts: {
    /** The run's history grant, which the proxy forwards with the query. */
    grant?: string | null;
    onLane(lane: LaneSummary): void;
    /** The stream is open: every lane there is has been, or is being, said. */
    onOpen?(): void;
    onDone?(): void;
    onError?(): void;
  },
): RunEventsSubscription {
  const query = opts.grant ? `?grant=${encodeURIComponent(opts.grant)}` : "";
  const url = `/api/v1/runs/${encodeURIComponent(runId)}/lanes/stream${query}`;
  // Closed while the tab is hidden, and reopened when it is back: the open says every lane again.
  const close = whileVisible(() => {
    const source = new EventSource(url);
    source.addEventListener("open", () => opts.onOpen?.());
    source.addEventListener("lane", (e) => {
      let lane: LaneSummary;
      try {
        lane = laneSummarySchema.parse(JSON.parse((e as MessageEvent).data));
      } catch {
        // A malformed frame is dropped; the listing remains the source of truth.
        return;
      }
      opts.onLane(lane);
    });
    source.addEventListener("done", () => {
      close();
      opts.onDone?.();
    });
    source.addEventListener("error", () => {
      if (source.readyState === EventSource.CLOSED) opts.onError?.();
    });
    return () => source.close();
  });
  return { close };
}

const LANE_HEAD = 50;
const LANE_TAIL = 200;
/** The most the historian answers in one read. */
const LANE_MIDDLE_MAX = 1_000;

/**
 * A subagent's transcript, read as the task page reads the run's: the first events and the newest,
 * and whatever lies between them when it is small enough to read with them. A lane is usually short,
 * so this is mostly one stretch read twice. Any read that fails fails the whole window; the tab says
 * so and offers to try again.
 */
export async function getLaneWindow(
  f: typeof fetch,
  runId: string,
  lane: string,
  grant?: string | null,
): Promise<HistoryWindow> {
  const [head, tail] = await Promise.all([
    getRunHead(f, runId, LANE_HEAD, grant, lane),
    getRunTail(f, runId, LANE_TAIL, grant, lane),
  ]);
  const hole = tail.firstSeq - head.lastSeq - 1;
  if (hole <= 0 || hole > LANE_MIDDLE_MAX) return { head, tail };
  const middle = await getRunEventsAfter(f, runId, head.lastSeq, hole, grant, lane);
  return { head, middle, tail };
}
