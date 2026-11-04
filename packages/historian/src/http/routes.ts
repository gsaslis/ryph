// The historian's HTTP surface, as a mountable route list — the same trick as @ryph/auth
// and @ryph/model-proxy: the Route shape is @ryph/shared's, so the default deployment spreads these into the host's route table.
//
// Invariants:
// - auth is injected, never owned: the host supplies the user gate (reads) and the per-run
//   bearer check (ingest). The historian cannot verify a run token — the runs table is the
//   host's — and must not grow its own idea of a user.
// - ingest is idempotent: duplicate (runId, lane, seq) triples are ACKED as duplicates, never
//   errored, which is what makes the runner's retry loop safe to fire blind.
// - every read is of ONE lane (`?lane=`, absent = `""`, the run's own transcript), and a lane that
//   is not `""` or `sa-<n>` is a 400 before anything is read. The run's read gate covers all of
//   its lanes, the lane listing and its live stream included: a subagent is part of the run, not a
//   grant of its own.
// - the stream never misses and never duplicates: subscribe FIRST, buffer live arrivals,
//   replay from the store, then drain the buffer — dedup by seq closes the overlap.
// - the live channels (a run's browser, core/live.ts, and its background commands,
//   core/commands.ts) are the opposite of all that: held in memory, never stored, never replayed,
//   and a slow viewer is given less rather than more.

import { bearerToken, endAtBearerExpiry } from "@ryph/sealed";
import { type Handler, json, parseBody, type Route, route } from "@ryph/shared/http";
import type { HistorianService } from "../core/service.ts";
import { type HistoryEvent, LANE, type LaneSummary, MAIN_LANE } from "../core/types.ts";
import {
  IngestBatchSchema,
  MAX_COMMANDS_LINE,
  MAX_INGEST_BYTES,
  MAX_LIVE_FRAME_LINE,
  parseCommandsLine,
  parseLiveLine,
} from "../schema.ts";
import { type LiveRooms, makeLiveRooms } from "../core/live.ts";
import { type CommandsRooms, makeCommandsRooms } from "../core/commands.ts";
import { CONCLUDED, type Rooms } from "../core/rooms.ts";
import { ndjsonLines } from "./ndjson.ts";

/**
 * The page size a caller gets for not asking. There was none: the route validated a `limit` it never
 * applied, so omitting it meant "the whole run", and the only caller omitted it. A run's history is
 * the fastest-growing data in the system and nothing prunes it yet, so that answer got slower and
 * heavier for the rest of the run's life. `hasMore` is how a caller that wants everything still gets
 * it — in pages it can stream, rather than one response that has to be built whole in memory first.
 */
const DEFAULT_LIMIT = 1_000;
const MAX_LIMIT = 1_000;
export const MAX_PAGE_BYTES = 1_048_576;
// Start small for large rows, then grow for ordinary small-event pages.
const INITIAL_PAGE_WINDOW = 8;

const KEEPALIVE_MS = 15_000;
/** The comment every stream opens with, so its headers are sent at once. */
const OPEN_FRAME = ": open\n\n";
/**
 * How long a concluded run's tail stays open before promising its record is complete. A run
 * goes terminal the moment the orchestrator persists the runner's result — but the runner only
 * flushes its LAST history batch afterwards, on the way out (its shutdown deadline is ~3s). Hang
 * up the instant the host says "terminal" and `done` would be a lie with events still inbound.
 */
const CONCLUDE_GRACE_MS = 4_000;
/**
 * The least time between two reads of the listing for one lanes stream. A signal is ingest's, and
 * ingest is the agent's to drive (the run token is readable in its container), so a stream that
 * read once per signal would read as often as the agent cared to write. Signals inside the window
 * are coalesced into one read at its end.
 */
const LANE_REFRESH_MS = 1_000;

/**
 * `seq` is an int4 column (adapters/store/db/schema.ts), and every cursor is bound into a
 * comparison against it — so a cursor outside int4 is not an empty answer, it is Postgres
 * refusing the whole statement with `value "…" is out of range for type integer`. A 500 for a
 * perfectly sensible ask: the app opens a run at its tail with `before=<Number.MAX_SAFE_INTEGER>`,
 * which means "newer than any event that could exist" and is exactly the number that blows up.
 *
 * Clamping says the same thing inside the column's range. Above int4 max there is nothing to
 * find, and below -1 there is nothing either (seqs start at 0), so every clamped cursor selects
 * precisely the rows the unclamped one named. Widen the column and this can go — the store test
 * on the real driver pins both ends of it.
 */
const INT4_MAX = 2_147_483_647;
/** The live uplink's outer line cap, the one a frame line gets: a line over it is dropped whole
 * rather than cut, before it is parsed. Smaller kinds get a smaller cap (`liveLineCap`). */
export const MAX_LIVE_LINE_BYTES = MAX_LIVE_FRAME_LINE;
const clampSeq = (seq: number): number => Math.min(Math.max(seq, -1), INT4_MAX);

/**
 * Who is watching, for the per-principal viewer cap: the user a bearer names. Read only AFTER the
 * read gate passed, which verified that bearer (every bearer here is a @ryph/auth access token,
 * an API token's included), so the subject is not taken on the caller's word. A request with no
 * readable subject (RYPH_AUTH=off) is everyone's: they share one principal.
 */
function principalOf(req: Request): string {
  const payload = bearerToken(req)?.split(".")[1];
  if (payload === undefined) return "";
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === "string" ? `user:${sub}` : "";
  } catch {
    return "";
  }
}

/** How many history batches one run may have being read at once; the next answers 429 unread.
 * The runner's emitter has one in flight, ever, so two is a retry overlapping its original — and
 * anything past that is a run token holding this process's memory, not a runner. */
export const MAX_INGESTS_IN_FLIGHT = 2;
/** How long one batch may take to arrive (408 past it): a slow drip holds its slot and what it
 * has sent, and the runner's own post gives up long before this. */
export const INGEST_DEADLINE_MS = 30_000;

export interface HistorianRoutesDeps {
  service: HistorianService;
  /**
   * The host's per-run read gate: null means proceed, a Response is the refusal to send. A run
   * grant from the control plane passes, as does a bearer holding `tasks:read-all`.
   */
  authenticateRunRead(req: Request, runId: string): Promise<Response | null>;
  /**
   * The host's per-run bearer check for ingest — a closure over its runs table. False for
   * unknown run and bad token alike, so the 401 confirms nothing about which run ids exist.
   */
  authenticateRun(req: Request, runId: string): Promise<boolean>;
  /** Lets a tail on an ALREADY-finished run replay and hang up instead of idling. */
  isRunTerminal?(runId: string): Promise<boolean>;
  /** Overrides INGEST_DEADLINE_MS — tests shorten it. */
  ingestDeadlineMs?: number;
  /** Overrides CONCLUDE_GRACE_MS — tests shorten it to keep the suite honest and fast. */
  concludeGraceMs?: number;
  /** Overrides LANE_REFRESH_MS, the least time between two reads of one lanes stream's listing. */
  laneRefreshMs?: number;
  /** The live channel's rooms. Defaults to a fresh registry; tests pass one with a fake clock. */
  liveRooms?: LiveRooms;
  /** The background commands' rooms, likewise. */
  commandRooms?: CommandsRooms;
  /** Overrides KEEPALIVE_MS on the live stream, which is also when it sweeps expired rooms. */
  liveKeepaliveMs?: number;
  /** Where the live uplink reports what it dropped. Optional: the drops also go back in its
   * response body. */
  diag?: { debug(event: string, fields?: Record<string, unknown>): void };
}

export interface HistorianHttp {
  routes: Route[];
  /**
   * The host's signal that a run reached a terminal state — call it once the run is PERSISTED,
   * so a client that reloads on `done` is guaranteed to read the final state.
   *
   * A run ending is not a history event: the lifecycle trail lives in the host's `run_events`,
   * which the historian never sees. Without this a finished run's tails would idle on a
   * keepalive drip forever, and their watchers would never learn the run is over. Cheap, total,
   * idempotent, and safe to call for a run nobody is watching.
   *
   * It also ends the run's live channels, the browser's and the background commands': each
   * uplink is hung up and its viewers told `done`.
   */
  concludeRun(runId: string): void;
}

export function historianRoutes(deps: HistorianRoutesDeps): HistorianHttp {
  const { service } = deps;

  // Open SSE tails, by run. Transport state, not core state — the service has no idea an HTTP
  // tail exists, and a split-out historian would reach this same registry over its own route.
  const tails = new Map<string, Set<() => void>>();

  const addTail = (runId: string, onConcluded: () => void): () => void => {
    let open = tails.get(runId);
    if (open === undefined) {
      open = new Set();
      tails.set(runId, open);
    }
    open.add(onConcluded);
    // Idempotent for the same reason the bus's unsubscribe is (see adapters/bus/memory.ts): `stop`
    // below is reachable twice — once from `cancel` when the client hangs up, once from `hangUp` —
    // and a second detach would delete a map entry that by then belongs to the next tail on this
    // run. That tail would stay open, still receiving events, but never hearing the run conclude.
    let done = false;
    return () => {
      if (done) return;
      done = true;
      open.delete(onConcluded);
      if (open.size === 0 && tails.get(runId) === open) tails.delete(runId);
    };
  };

  const rooms = deps.liveRooms ?? makeLiveRooms();
  const commandRooms = deps.commandRooms ?? makeCommandsRooms();

  const concludeRun = (runId: string): void => {
    // Copy: each callback detaches itself from the set it is being iterated over.
    for (const onConcluded of [...(tails.get(runId) ?? [])]) onConcluded();
    rooms.conclude(runId);
    commandRooms.conclude(runId);
  };

  /** Batches being read per run, for MAX_INGESTS_IN_FLIGHT. In memory: per process, as the
   * historian is one replica, mounted or standalone. */
  const ingestsInFlight = new Map<string, number>();

  const ingest = async (req: Request, params: Record<string, string>): Promise<Response> => {
    if (!(await deps.authenticateRun(req, params.id))) {
      await req.body?.cancel().catch(() => {});
      return json(401, { error: "unauthorized" });
    }
    const inFlight = ingestsInFlight.get(params.id) ?? 0;
    if (inFlight >= MAX_INGESTS_IN_FLIGHT) {
      await req.body?.cancel().catch(() => {});
      return json(429, { error: "too many history batches in flight for this run" });
    }
    ingestsInFlight.set(params.id, inFlight + 1);
    let body;
    try {
      body = await parseBody(req, IngestBatchSchema, {
        maxBytes: MAX_INGEST_BYTES,
        signal: AbortSignal.timeout(deps.ingestDeadlineMs ?? INGEST_DEADLINE_MS),
      });
    } finally {
      const left = (ingestsInFlight.get(params.id) ?? 1) - 1;
      if (left <= 0) ingestsInFlight.delete(params.id);
      else ingestsInFlight.set(params.id, left);
    }
    if (!body.ok) {
      return body.res.status === 413 ? json(413, { error: "history batch too large" }) : body.res;
    }
    const outcome = await service.ingest(params.id, body.data.events);
    return json(200, outcome);
  };

  /** `after` (query): only events with seq strictly greater. Absent means everything. */
  const parseAfter = (url: URL): number | Response => {
    const raw = url.searchParams.get("after");
    if (raw === null) return -1;
    const after = Number(raw);
    if (!Number.isInteger(after)) return json(400, { error: "after must be an integer" });
    return clampSeq(after);
  };

  /**
   * Which way this page walks. `after` goes forwards from a seq (the default, `-1`); `before` goes
   * backwards from one, which is how a reader opens a run at its tail — `before=<a huge seq>` is
   * "the newest page". Both at once has no meaning (they would fight over which end `limit` cuts),
   * so it is a 400 rather than a silent winner.
   */
  const parseWindow = (
    url: URL,
  ): { after: number; before?: number } | Response => {
    const rawBefore = url.searchParams.get("before");
    if (rawBefore === null) {
      const after = parseAfter(url);
      return after instanceof Response ? after : { after };
    }
    if (url.searchParams.get("after") !== null) {
      return json(400, { error: "after and before are mutually exclusive" });
    }
    const before = Number(rawBefore);
    if (!Number.isInteger(before)) return json(400, { error: "before must be an integer" });
    return { after: -1, before: clampSeq(before) };
  };

  /** `lane` (query): which of the run's lanes. Absent, or empty, is the run's own transcript. */
  const parseLane = (url: URL): string | Response => {
    const lane = url.searchParams.get("lane") ?? MAIN_LANE;
    if (!LANE.test(lane)) return json(400, { error: 'lane must be "" or sa-<n>' });
    return lane;
  };

  const list = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticateRunRead(req, params.id);
    if (denied) return denied;
    const url = new URL(req.url);
    const lane = parseLane(url);
    if (lane instanceof Response) return lane;
    const window = parseWindow(url);
    if (window instanceof Response) return window;
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return json(400, { error: `limit must be an integer between 1 and ${MAX_LIMIT}` });
    }

    const events: HistoryEvent[] = [];
    let hasMore = false;
    let bytes = 256; // response envelope and cursors
    const encoder = new TextEncoder();
    let next = window;
    let pageWindow = INITIAL_PAGE_WINDOW;
    paging: while (true) {
      const readLimit = Math.min(pageWindow, limit - events.length + 1);
      const rows = await service.listEvents(params.id, lane, {
        ...next,
        limit: readLimit,
      });
      if (rows.length === 0) break;
      // Walk from the requested cursor, then restore ascending order for the wire.
      if (window.before !== undefined) rows.reverse();
      for (const event of rows) {
        const size = encoder.encode(JSON.stringify(event)).byteLength + 1;
        // Always return one row, including legacy rows larger than today's ingest ceiling,
        // so a reader can advance rather than getting stuck on an empty page forever.
        if (events.length >= limit || (events.length > 0 && bytes + size > MAX_PAGE_BYTES)) {
          hasMore = true;
          break paging;
        }
        events.push(event);
        bytes += size;
      }
      // A short read exhausted this direction; no extra empty query is needed.
      if (rows.length < readLimit) break;
      pageWindow *= 2;
      const last = events[events.length - 1].seq;
      next = window.before === undefined ? { after: last } : { after: -1, before: last };
    }
    if (window.before !== undefined) events.reverse();
    // An empty page has no seqs to report, so it reports the cursor it was asked from — which is
    // exactly the cursor a caller should present again to resume in the same direction.
    const cursor = window.before ?? window.after;
    const firstSeq = events.length > 0 ? events[0].seq : cursor;
    const lastSeq = events.length > 0 ? events[events.length - 1].seq : cursor;
    // `hasMore` reads in the direction of travel: going forwards it means newer events remain,
    // going backwards it means OLDER ones do.
    return json(200, { events, firstSeq, lastSeq, hasMore });
  };

  const stream = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticateRunRead(req, params.id);
    if (denied) return denied;
    const runId = params.id;
    const url = new URL(req.url);
    // The lane is the stream's identity, not a cursor: a reconnect presents it again in the URL,
    // and its Last-Event-ID is a seq in that lane's counter.
    const lane = parseLane(url);
    if (lane instanceof Response) return lane;
    // On reconnect EventSource presents the last id it saw — that wins over the query param.
    const lastEventId = req.headers.get("last-event-id");
    let after: number;
    if (lastEventId !== null) {
      after = Number(lastEventId);
      // A reconnecting EventSource presents whatever id it last saw, and a client is free to
      // present a made-up one — which reaches the replay query as a bind parameter like any
      // other cursor, so it gets the same clamp the query params get.
      after = Number.isInteger(after) ? clampSeq(after) : -1;
    } else {
      const parsed = parseAfter(url);
      if (parsed instanceof Response) return parsed;
      after = parsed;
    }

    const encoder = new TextEncoder();
    let unsubscribe = () => {};
    let detach = () => {};
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    // Set by the first `stop`. A client can hang up while `start` is still awaiting, and `cancel`
    // then runs `stop` before the tail and the keepalive exist; `start` checks this after every
    // await and stops again, or the interval would tick forever and the tail outlive the stream.
    let stopped = false;
    const stop = () => {
      stopped = true;
      unsubscribe();
      detach();
      if (keepalive !== undefined) clearInterval(keepalive);
      if (grace !== undefined) clearTimeout(grace);
    };

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let lastSent = after;
        let closed = false;
        const enqueue = (frame: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            closed = true; // the client went away mid-frame; cancel() does the cleanup
          }
        };
        // A comment straight away, before the replay is read: a server (Bun's among them) holds a
        // response's headers back until its first chunk, and every hop in front of it does too,
        // so without one an EventSource sits in "connecting" until there is news or a keepalive.
        enqueue(OPEN_FRAME);
        const send = (event: HistoryEvent) => {
          if (event.seq <= lastSent) return; // the replay/live overlap, deduped
          lastSent = event.seq;
          enqueue(`id: ${event.seq}\nevent: history\ndata: ${JSON.stringify(event)}\n\n`);
        };

        const isTerminal = deps.isRunTerminal;
        /** The record is complete: say so and hang up. */
        const hangUp = () => {
          enqueue(`event: done\ndata: {}\n\n`);
          stop();
          if (!closed) controller.close();
        };

        // Subscribe first and buffer: nothing published during the replay query can be lost,
        // and draining the buffer through send() dedups whatever the replay already covered.
        let replaying = true;
        const buffered: HistoryEvent[] = [];
        unsubscribe = service.subscribe(runId, lane, (event) => {
          if (replaying) buffered.push(event);
          else send(event);
        });
        const replay = await service.listEvents(runId, lane, { after });
        if (stopped) return stop();
        for (const event of replay) send(event);
        replaying = false;
        for (const event of buffered) send(event);

        // A run that concludes WHILE this tail is open: the host tells us, since nothing on the
        // bus announces it. A conclusion is the run's, so it ends every lane's tails alike. Registered BEFORE the terminal check below, so a run concluding in
        // the gap is caught by one or the other, never neither.
        let concluding = false;
        detach = addTail(runId, () => {
          if (concluding) return;
          concluding = true;
          grace = setTimeout(async () => {
            if (closed) return;
            // Verify against the store before promising the record is whole — the runner's last
            // batch lands after its result, and a bus delivery can drop.
            try {
              for (const event of await service.listEvents(runId, lane, { after: lastSent })) {
                send(event);
              }
            } catch {
              // Best-effort: the paginated GET stays the source of truth either way.
            }
            hangUp();
          }, deps.concludeGraceMs ?? CONCLUDE_GRACE_MS);
        });

        // A run that concluded BEFORE this tail opened: the replay above already carried its
        // whole record and the runner is long gone, so there is nothing to wait for.
        const terminal = isTerminal ? await isTerminal(runId) : false;
        if (stopped) return stop();
        if (terminal) {
          concluding = true;
          hangUp();
          return;
        }

        keepalive = setInterval(() => enqueue(`: keepalive\n\n`), KEEPALIVE_MS);
      },
      cancel: stop,
    });

    // Gated once, at open: an API token's stream ends when its bearer does, and the client
    // reconnects with a fresh one, which the gate checks again. A session's is left alone.
    return endAtBearerExpiry(
      req,
      new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        },
      }),
    );
  };

  /**
   * The run's subagent lanes, each with its opening, latest continuation and latest close — what a
   * viewer draws the run's list of subagents from, with nothing asked of the control plane. Not
   * paged, because it is bounded: at most MAX_SUBAGENT_LANES lanes (the boundary refuses any
   * other), each three clipped events, read with LIMITed probes whatever the lanes hold.
   */
  const lanes = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticateRunRead(req, params.id);
    if (denied) return denied;
    return json(200, { lanes: await service.listLanes(params.id) });
  };

  /**
   * The lane listing, live: every current `LaneSummary` on connect, then a lane's fresh summary
   * each time one of its start, resume or end events is stored, as `event: lane` (no `id:` — there
   * is no cursor to resume from; a reconnect is sent the whole listing again). `done` when the run
   * concludes, after the same grace and re-read as the event stream's, or at once if it already had.
   *
   * The same never-miss discipline as the event stream, on signals rather than events: subscribe
   * FIRST, read the listing, then refresh whatever lanes signalled meanwhile. A signal only says
   * "read again", so a refresh re-reads the listing (one query) and sends a lane only when its
   * summary differs from the one this viewer was last sent: duplicates, a replica's echo of its
   * own signal and the snapshot overlap all collapse there. Refreshes run one at a time, at most
   * one per LANE_REFRESH_MS, and signals arriving during one or before the next is due are
   * coalesced into the next.
   */
  const lanesStream = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticateRunRead(req, params.id);
    if (denied) return denied;
    const runId = params.id;

    const encoder = new TextEncoder();
    let unsubscribe = () => {};
    let detach = () => {};
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    // The wait for the next read to fall due, and how to cut it short.
    let pause: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | undefined;
    // Set by the first `stop`. A client can hang up while `start` is still awaiting, and `cancel`
    // then runs `stop` before the tail and the keepalive exist; `start` checks this after every
    // await and stops again, or the interval would tick forever and the tail outlive the stream.
    let stopped = false;
    const stop = () => {
      stopped = true;
      unsubscribe();
      detach();
      if (keepalive !== undefined) clearInterval(keepalive);
      if (grace !== undefined) clearTimeout(grace);
      if (pause !== undefined) {
        clearTimeout(pause.timer);
        pause.resolve();
        pause = undefined;
      }
    };
    const refreshMs = deps.laneRefreshMs ?? LANE_REFRESH_MS;

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const enqueue = (frame: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            closed = true; // the client went away mid-frame; cancel() does the cleanup
          }
        };
        enqueue(OPEN_FRAME);

        // What this viewer was last sent, per lane, serialized: the dedup.
        const sent = new Map<string, string>();
        /** Sends the lanes in `only` (every lane if null) whose summary changed since last sent. */
        const sendChanged = (lanes: LaneSummary[], only: Set<string> | null) => {
          for (const summary of lanes) {
            if (only !== null && !only.has(summary.lane)) continue;
            const data = JSON.stringify(summary);
            if (sent.get(summary.lane) === data) continue;
            sent.set(summary.lane, data);
            enqueue(`event: lane\ndata: ${data}\n\n`);
          }
        };

        // When the listing was last read, and the read itself: every read goes through here.
        let lastRead = -Infinity;
        const read = () => {
          lastRead = Date.now();
          return service.listLanes(runId);
        };
        /** Waits until the next read is due, or the stream stops. */
        const due = async () => {
          const wait = lastRead + refreshMs - Date.now();
          if (wait <= 0 || stopped) return;
          await new Promise<void>((resolve) => {
            pause = { timer: setTimeout(resolve, wait), resolve };
          });
          pause = undefined;
        };

        // Signals that arrive before the snapshot, or during a refresh, wait here.
        let dirty = new Set<string>();
        // Set when the next refresh is to send every lane that changed, signalled or not.
        let everything = false;
        let ready = false;
        let refreshing: Promise<void> | null = null;
        const refresh = (): Promise<void> => {
          if (refreshing !== null) return refreshing;
          if (dirty.size === 0 && !everything) return Promise.resolve();
          // Assigned before the body runs: an async function runs synchronously up to its first
          // await, so a body that found nothing to do would clear `refreshing` before this line
          // set it, and leave every later refresh waiting on a promise that already settled.
          let settled!: () => void;
          refreshing = new Promise<void>((resolve) => (settled = resolve));
          void (async () => {
            try {
              while ((dirty.size > 0 || everything) && !closed && !stopped) {
                await due();
                if (closed || stopped) break;
                const lanes = everything ? null : dirty;
                dirty = new Set();
                everything = false;
                sendChanged(await read(), lanes);
              }
            } catch {
              // Best-effort: the next signal, a reconnect or GET /lanes reads again.
            } finally {
              refreshing = null;
              settled();
            }
          })();
          return refreshing;
        };
        unsubscribe = service.subscribeLanes(runId, (lane) => {
          dirty.add(lane);
          if (ready) void refresh();
        });
        sendChanged(await read(), null);
        if (stopped) return stop();
        ready = true;
        void refresh();

        const hangUp = () => {
          enqueue(`event: done\ndata: {}\n\n`);
          stop();
          if (!closed) controller.close();
        };
        let concluding = false;
        detach = addTail(runId, () => {
          if (concluding) return;
          concluding = true;
          grace = setTimeout(async () => {
            if (closed) return;
            // The runner's last batch, a lane's `run_ended` end among it, lands after its result,
            // and a bus delivery can drop: one more read, of every lane, through the same window.
            everything = true;
            await refresh();
            if (closed || stopped) return;
            hangUp();
          }, deps.concludeGraceMs ?? CONCLUDE_GRACE_MS);
        });
        const terminal = deps.isRunTerminal ? await deps.isRunTerminal(runId) : false;
        if (stopped) return stop();
        if (terminal) {
          concluding = true;
          hangUp();
          return;
        }
        keepalive = setInterval(() => enqueue(`: keepalive\n\n`), KEEPALIVE_MS);
      },
      cancel: stop,
    });

    // Gated once, at open: an API token's stream ends when its bearer does, and the client
    // reconnects with a fresh one, which the gate checks again. A session's is left alone.
    return endAtBearerExpiry(
      req,
      new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        },
      }),
    );
  };

  /**
   * An uplink route: one NDJSON body that stays open for the run, read line by line as it
   * arrives into `rooms`. Answers only when the body ends — the producer hung up, a newer uplink
   * replaced this one, or the run concluded — with what it did with the lines, which no producer
   * needs to act on but anyone debugging one does. An uplink the run's conclusion hung up is
   * answered 410, as one opened after it is, so a relay stops instead of reconnecting. `refused` counts lines that parsed but the
   * room would not take (a job it never heard start, one past its cap).
   */
  const uplinkRoute = <E>(
    rooms: Rooms<E, unknown>,
    maxLineBytes: number,
    parse: (line: string) => E | "oversize" | "malformed",
    channel: string,
  ): Handler =>
  async (req, params) => {
    const runId = params.id;
    if (!(await deps.authenticateRun(req, runId))) {
      return json(401, { error: "unauthorized" });
    }
    // 410, not 401: the token was good, the run is just over. A relay seeing this should stop.
    if (deps.isRunTerminal && (await deps.isRunTerminal(runId))) {
      return json(410, { error: "run concluded" });
    }
    if (req.body === null) return json(400, { error: "body must be an NDJSON stream" });
    const uplink = rooms.openUplink(runId);
    if (uplink === "concluded") return json(410, { error: "run concluded" });
    if (uplink === "full") return json(503, { error: "too many live runs" });

    const reader = req.body.getReader();
    const hangUp = () => reader.cancel().catch(() => {});
    uplink.signal.addEventListener("abort", hangUp, { once: true });
    let accepted = 0;
    let malformed = 0;
    let oversize = 0;
    let refused = 0;
    try {
      for await (const line of ndjsonLines(reader, maxLineBytes)) {
        if (line === null) {
          oversize++;
          continue;
        }
        if (line.trim() === "") continue;
        const event = parse(line);
        if (event === "oversize") {
          oversize++;
          continue;
        }
        if (event === "malformed") {
          malformed++;
          continue;
        }
        if (uplink.push(event)) accepted++;
        else refused++;
      }
    } catch {
      // The producer went away mid-body. That is how most uplinks end; nothing to answer it with.
    } finally {
      uplink.signal.removeEventListener("abort", hangUp);
      uplink.close();
    }
    if (malformed > 0 || oversize > 0 || refused > 0) {
      deps.diag?.debug(`${channel}.lines_dropped`, { runId, malformed, oversize, refused });
    }
    // Hung up because the run concluded: 410, as a late uplink is answered, so the relay stops
    // here rather than reconnecting once to be told so.
    if (uplink.signal.reason === CONCLUDED) {
      return json(410, { error: "run concluded", accepted, malformed, oversize, refused });
    }
    const replaced = uplink.signal.aborted;
    return json(200, { accepted, malformed, oversize, refused, replaced });
  };

  /**
   * An SSE frame per live item. The big ones — a snapshot (up to the room's budget) and a browser
   * frame — are encoded once and shared: every viewer of a run is handed the same object while the
   * room is unchanged, so N viewers cost one `JSON.stringify`, not N. Keyed weakly on the data, so
   * the bytes live exactly as long as it; the small events are not cached, so a room's rings are
   * not held twice over.
   */
  const encoded = new WeakMap<object, Uint8Array>();
  const sseEncoder = new TextEncoder();
  const SHARED_EVENTS = new Set(["snapshot", "frame"]);
  const sseFrame = (out: { event: string; data: unknown }): Uint8Array => {
    if (!SHARED_EVENTS.has(out.event) || typeof out.data !== "object" || out.data === null) {
      return sseEncoder.encode(`event: ${out.event}\ndata: ${JSON.stringify(out.data)}\n\n`);
    }
    let bytes = encoded.get(out.data);
    if (bytes === undefined) {
      bytes = sseEncoder.encode(`event: ${out.event}\ndata: ${JSON.stringify(out.data)}\n\n`);
      encoded.set(out.data, bytes);
    }
    return bytes;
  };

  /**
   * A stream route: the room's snapshot, then each event as it is relayed. Pull-driven — the next
   * item is only taken from the viewer's mailbox when the response is ready for it, so a viewer
   * whose connection is slow is exactly the one whose frames coalesce (core/rooms.ts).
   */
  const streamRoute = <Out extends { event: string; data: unknown }>(
    rooms: Rooms<unknown, Out>,
  ): Handler =>
  async (req, params) => {
    const denied = await deps.authenticateRunRead(req, params.id);
    if (denied) return denied;
    const runId = params.id;
    const terminal = deps.isRunTerminal ? await deps.isRunTerminal(runId) : false;
    const viewer = rooms.watch(runId, { terminal, principal: principalOf(req) });
    if (viewer === "full") return json(429, { error: "too many viewers on this run" });

    const encoder = new TextEncoder();
    let keepalive: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (keepalive !== undefined) clearInterval(keepalive);
      keepalive = undefined;
      viewer.leave();
    };

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Sent before the room, so the headers reach the viewer now (see `stream` above).
        controller.enqueue(encoder.encode(OPEN_FRAME));
        keepalive = setInterval(async () => {
          // The live channel's only clock: rooms past their expiry go on someone's keepalive.
          rooms.sweep();
          try {
            controller.enqueue(encoder.encode(`: keepalive\n\n`));
          } catch {
            stop(); // the client went away; cancel() may already have run
            return;
          }
          // A conclude signal can be lost (a NOTIFY between replicas; the orchestrator's ping is
          // retried, but not forever), and a viewer must not then wait on keepalives forever: the
          // host's word that the run is terminal concludes the room here, which says `done` to
          // every viewer of it.
          try {
            if (deps.isRunTerminal && !viewer.finished && (await deps.isRunTerminal(runId))) {
              rooms.conclude(runId);
            }
          } catch {
            // Asked again on the next keepalive.
          }
        }, deps.liveKeepaliveMs ?? KEEPALIVE_MS);
      },
      async pull(controller) {
        while (!viewer.finished) {
          const out = viewer.take();
          if (out === null) {
            await viewer.ready();
            continue;
          }
          controller.enqueue(sseFrame(out));
          if (out.event === "done") {
            stop();
            controller.close();
          }
          return;
        }
      },
      cancel: stop,
    }, { highWaterMark: 1 });

    // Gated once, at open: an API token's stream ends when its bearer does, and the client
    // reconnects with a fresh one, which the gate checks again. A session's is left alone.
    return endAtBearerExpiry(
      req,
      new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        },
      }),
    );
  };

  // The runner's relay of its browser sidecar, and the browser as viewers see it.
  const liveIngest = uplinkRoute(rooms, MAX_LIVE_LINE_BYTES, parseLiveLine, "live");
  const liveStream = streamRoute(rooms);
  // The runner's background commands (core/commands.ts): a channel of its own, never mixed into
  // the browser's, under the same gates.
  const commandsIngest = uplinkRoute(
    commandRooms,
    MAX_COMMANDS_LINE,
    parseCommandsLine,
    "live_commands",
  );
  const commandsStream = streamRoute(commandRooms);

  return {
    routes: [
      route("POST", "/v1/runs/:id/events", ingest),
      route("GET", "/v1/runs/:id/events", list),
      route("GET", "/v1/runs/:id/events/stream", stream),
      route("GET", "/v1/runs/:id/lanes", lanes),
      route("GET", "/v1/runs/:id/lanes/stream", lanesStream),
      route("POST", "/v1/runs/:id/live", liveIngest),
      route("GET", "/v1/runs/:id/live/stream", liveStream),
      route("POST", "/v1/runs/:id/live/commands", commandsIngest),
      route("GET", "/v1/runs/:id/live/commands/stream", commandsStream),
    ],
    concludeRun,
  };
}
