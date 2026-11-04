// How many streams the tunnels of one process may hold, and whose they are: plain counts, enforced
// when a stream is asked for, and never by taking one from somebody else. They are for fairness, so
// that one run, or a few, can never take what every other run needs; they are not what keeps the
// process inside its memory. That is measured, not estimated: the hosted service samples its pod's
// real memory and, past a watermark, has the budget refuse new streams to the groups it names
// (`pressure`, asked per group), empty their part of the line and close every stream of theirs
// that holds bytes (`relieve`) and, nearer the limit, close the streams that hold the most
// whoever's they are (`shed`). What each group holds (`usage`) is how the service tells which
// groups to name.
//
// A group (a run, across its previews) holds at most its cap's `open` streams, of which its
// long-lived ones (WebSockets, SSE) at most `long`, so a run whose pages hold many of those still
// has room for a save or an API call. The process holds at most `streams` streams for the runs it
// owns, of which long-lived at most LONG_SHARE, so idle sockets in open tabs across many runs never
// take the room every run's short requests need; and, apart from them, at most `relays` relays (a
// request this process sends on to another that owns its run), of which long-lived LONG_SHARE too.
// The two never borrow from each other, streams or places in line, so the runs this process owns
// keep all of theirs however many relays it carries. A request past any cap waits in line — at most
// its cap's `waiting` short and `waitingLong` long-lived requests per group; past its first
// LINE_FLOOR places, only while its part's line (POD_WAITING for the owned runs, `relayWaiting` for
// relays) is short of what the floors leave (LINE_RESERVE less) and the group holds less than half
// of what the others leave of that — for WAIT_MS, oldest first, and is then turned away (503).
// Twelve groups at their caps fill the owned streams, and twelve at their floors the owned line:
// some twelve colluding runs on a pod are where it starves the others, by design. Short of that,
// runs that also take places past their floors fill it sooner (seven leave an honest run its
// floor; the eighth does not).
//
// A stream whose reader has stopped taking what it holds is closed after STALL_MS, but only when
// closing it lets a request in line in. Anything else — a paused <video>, a breakpoint, a tab in
// the background — costs nobody, and stays, unless the service names its group under memory
// pressure (`relieve`).
//
// How fast its tunnels' acks go, and so how much of the process's time each run's tunnels take, is
// its pacer's (`pace.ts`): per run across its tunnels, and per process, split fairly between runs.
import { Pacer, type PacerOptions } from "./pace.ts";

/** Streams one socket carries at once: the wire's own cap, which the runner end holds to as well.
 * A run's cap (PER_RUN) is exactly one full tunnel's streams. */
export const MAX_STREAMS = 64;

/** What one group may hold and have waiting, in streams and requests. */
export interface Cap {
  /** What refusals name it: `run`, or `relay` (`run-long`, `relay-line`, …). */
  name: string;
  /** Streams open at once. */
  open: number;
  /** Of them, long-lived streams; the rest is kept for short requests. */
  long: number;
  /** Short requests waiting in line at once. */
  waiting: number;
  /** Long-lived requests waiting in line at once, counted apart, so those stuck behind the
   * group's `long` never fill the line its short requests wait in. */
  waitingLong: number;
}

/**
 * One run's, across all its previews. 64 streams is a tunnel's full width (MAX_STREAMS), or a
 * page and the API it calls both loading. Long-lived streams hold at most 48 (a Jupyter kernel's
 * sockets, or a Storybook's, for a few people at once): the last 16 are kept for the page's short
 * requests, which would otherwise wait behind sockets that never end and then fail. 512 waiting is
 * a Vite full reload in four browsers at once over HTTP/2, which sends up to 100 requests at once
 * per connection: some 400, 64 open and the rest in line. 64 long-lived waiting is a reconnect of
 * every socket of a busy page in a few tabs. Constants: a pod with more memory serves more runs,
 * not one run more.
 */
export const PER_RUN: Cap = {
  name: "run",
  open: MAX_STREAMS,
  long: 48,
  waiting: 512,
  waitingLong: 64,
};
/** Streams the runs a process owns may hold at once, in all: twelve runs at their caps. */
export const POD_STREAMS = 12 * PER_RUN.open;
/** Of a process's streams (and of its relays), what long-lived ones may hold: the last quarter is
 * kept for short requests, whoever's. */
export const LONG_SHARE = 3 / 4;
/** Requests that may wait at once, across every group: three lines of a run at its cap. */
export const POD_WAITING = 3 * PER_RUN.waiting;
/** Places in line every group may take while the process's line has room (at most its cap's
 * `waiting`), whatever the others hold: a cold page load's burst, so an honest run is never
 * squeezed to a few places by others that fill their parts. Past it a group takes at most half of
 * what the others leave of the line short of LINE_RESERVE. */
export const LINE_FLOOR = 128;
/** Of the process's line, what only groups within their floor may fill: four more runs' floors
 * however full the others filled the rest. The process's line stays POD_WAITING either way. */
export const LINE_RESERVE = 4 * LINE_FLOOR;
/** How long a request waits in line before it is turned away. A cold dev server (Vite optimising
 * its dependencies) can hold every stream of a page this long. */
export const WAIT_MS = 30_000;
/** A stream with bytes its reader has not taken for this long is closed, while it is needed. */
export const STALL_MS = 30_000;
/** What a stream that holds bytes costs beyond them while nothing measures its client: its
 * client socket's kernel buffers (at most 128 KiB each way where the pod caps them) and its
 * parser, roughly. A stream the proxies serve (`serves`) has its client's buffers counted live
 * instead, the kernel's included while they fill, and costs SERVED_BYTES beyond them: counting
 * this too would count the same kernel buffer twice. What is left at this estimate is a stream
 * whose client nobody measures: a WebSocket whose upgrade the dev server has not answered yet, or
 * a stream of a caller that serves no client (`serves`). Counted for what closing it frees, and
 * for what its group holds (`usage`), only while it holds any: an idle stream holds next to
 * nothing, and counting it would name a run for its open tabs. An estimate, never a bound. */
export const STREAM_BYTES = 128 * 1024;
/** What a stream whose client is measured (`serves`) costs beyond its bytes and its client's:
 * the client's parser and the objects of its exchange, roughly (a request's head is at most
 * 16 KiB). Counted as STREAM_BYTES is, only while it holds any. An estimate, never a bound. */
export const SERVED_BYTES = 16 * 1024;
const SWEEP_MS = 5_000;

/** How near the process is to its memory limit, as its guard measures it. */
export type Pressure = "normal" | "high" | "critical";

/** Why the budget turned a request away or closed a stream: what an operator sees in the log. */
export type Refusal =
  /** The group's line, or the process's, was full: refused at once. */
  | "line full"
  /** It waited its time in line and nothing freed. */
  | "wait expired"
  /** A stream's reader took nothing for STALL_MS while its stream was needed. */
  | "stalled"
  /** The process is near its memory limit: refused at once, or closed. */
  | "memory";

/**
 * Which limit it was: `run`, `run-long`, `run-line` (a group's, `relay-…` for a relay's), `pod`,
 * `pod-long`, `pod-relay`, `pod-line` and `pod-relay-line` (the process's), `tunnel` (its tunnel's MAX_STREAMS), or
 * `memory-high` / `memory-critical`.
 */
export type CapName = string;

/** One stream's charge, from its opening until it is released. */
export interface Charge {
  /** Bytes the stream holds that its reader, either way, has not taken. Set by the stream. */
  buffered(): number;
  /** Bytes its readers have taken in all, either way: any change is progress, however small or
   * however they took it. Set by the stream. */
  taken(): number;
  /** Closes the stream (stalled, or shed). Set by the stream; it releases the charge. */
  close(): void;
  /** Counts the stream as long-lived from now on: it turned out to be one (an event stream asked
   * for without saying so). False, and it stays short, when the long-lived caps are full. */
  promote(): boolean;
  /** Gives the charge back. Only the first call counts. */
  release(): void;
}

/** What a stream is, to the budget. */
export interface Kind {
  /** A WebSocket or an event stream: it may never end, so it counts against the group's `long`
   * and the process's LONG_SHARE as well. */
  long?: boolean;
  /** A request sent on to another process that owns its run: it counts against `relays`, not
   * `streams`. */
  relay?: boolean;
}

export interface Acquire<T> extends Kind {
  /** The group's cap. Default PER_RUN. Every request of one group must name the same. */
  cap?: Cap;
  /** Whether it could use a stream now, budget aside (its tunnel has one free). */
  ready?: () => boolean;
  /** Gives up its place in line. */
  signal?: AbortSignal;
  /** How long it may wait in line, when less is left of the request's own wait than the
   * budget's (it already waited on another process). Default: the budget's. */
  waitMs?: number;
  /** Runs at once with the charge, before any other request is served. A throw gives the charge
   * back and rejects. */
  use: (charge: Charge) => T;
}

interface Group {
  cap: Cap;
  open: number;
  long: number;
  /** Short requests in line. */
  waiting: number;
  /** Long-lived requests in line. */
  waitingLong: number;
}

/** What a request needs to be let in. */
interface Need {
  group: Group;
  long: boolean;
  relay: boolean;
  ready: () => boolean;
}

interface Waiter extends Need {
  key: unknown;
  grant(charge: Charge): void;
  /** Turns it away: the process is near its memory limit. */
  shed(cap: CapName): void;
}

/** What one group holds now: `usage()`. */
export interface GroupUsage {
  /** Streams open. */
  open: number;
  /** Requests in line, short and long-lived. */
  waiting: number;
  /** Bytes its streams hold that their readers have not taken, either way. */
  buffered: number;
  /** Of its streams, those holding any such bytes. */
  holding: number;
  /** What those cost beyond their bytes: SERVED_BYTES each whose client is measured (`serves`),
   * STREAM_BYTES each otherwise. */
  overhead: number;
}

/** What an open charge holds, and what the sweep remembers of it: when its reader last made
 * progress. */
interface Held {
  key: unknown;
  group: Group;
  long: boolean;
  relay: boolean;
  taken: number;
  since: number;
}

export interface BudgetOptions {
  /** Streams the runs this process owns may hold at once. Default POD_STREAMS. */
  streams?: number;
  /** Relays it may hold at once, apart from `streams`. Default 0: a process that relays nothing. */
  relays?: number;
  /** Requests waiting at once, across every group of the runs it owns. Default POD_WAITING. */
  waiting?: number;
  /** Relays waiting at once, in a line apart from `waiting`. Default: as many to `relays` as
   * `waiting` is to `streams`. */
  relayWaiting?: number;
  /** How near the process is to its memory limit as it applies to `group`, asked as each of its
   * requests comes and as the line is served: a group the guard does not name is served as usual
   * while others are refused. Default: always normal. */
  pressure?: (group: unknown) => Pressure;
  /** Hears every refusal, with the group it was for and which limit it was. Called as it
   * happens: the caller rate-limits whatever it logs. */
  refused?: (group: unknown, why: Refusal, cap: CapName) => void;
  /** Seam for tests. */
  now?: () => number;
  /** How long a request waits. Default WAIT_MS. Seam for tests. */
  waitMs?: number;
  /** Its tunnels' ack pace (`pacer`). Default: the pacer's own, on `now`'s clock. */
  pace?: PacerOptions;
}

const busy = () => new Error("preview is busy");

/** Which charge a stream holds, for `promote`. */
const charges = new WeakMap<object, Charge>();
/** Charges whose client is measured (`serves`). */
const measured = new WeakSet<Charge>();

/** What `charge` costs beyond its bytes while it holds any (STREAM_BYTES, SERVED_BYTES). */
function overhead(charge: Charge): number {
  return measured.has(charge) ? SERVED_BYTES : STREAM_BYTES;
}

/** Remembers that `stream` holds `charge`, so the proxy can promote it (`promote`). */
export function holdsCharge(stream: object, charge: Charge): void {
  charges.set(stream, charge);
}

/** The client a stream serves, as its charge sees it (`serves`). */
export interface Served {
  /** Bytes held for the client that the stream's own count leaves out: its socket's buffers, and
   * what its kernel holds of them. */
  held(): number;
  /** Aborts the client's exchange when the charge is closed (stalled, or shed). */
  cut(): void;
}

/**
 * Has `stream`'s charge, when it holds one, count what `served` holds as its own and cut the
 * client before the stream when it is closed: so the stall rule and the memory guard see a body
 * paused unread, or a response its client stopped reading, and closing the stream frees them at
 * once rather than leaving them to the kernel.
 */
export function serves(stream: object, served: Served): void {
  const charge = charges.get(stream);
  if (charge === undefined) return;
  measured.add(charge);
  const buffered = charge.buffered;
  const close = charge.close;
  charge.buffered = () => buffered() + Math.max(0, served.held());
  charge.close = () => {
    served.cut();
    close();
  };
}

/** Counts `stream`'s charge as long-lived, when it holds one (`Charge.promote`). */
export function promote(stream: object): boolean {
  return charges.get(stream)?.promote() ?? false;
}

export class Budget {
  /** Streams the runs this process owns may hold. */
  readonly streams: number;
  /** Of them, long-lived ones (LONG_SHARE). */
  readonly longStreams: number;
  /** Relays it may hold, apart from `streams`. */
  readonly relays: number;
  /** Of them, long-lived ones (LONG_SHARE). */
  readonly longRelays: number;
  /** Requests that may wait at once, across every group of the runs it owns. */
  readonly maxWaiting: number;
  /** Relays that may wait at once, apart from `maxWaiting`. */
  readonly maxRelaysWaiting: number;
  readonly now: () => number;
  /** The pace its tunnels' acks keep, per group and in all. */
  readonly pacer: Pacer;
  readonly #waitMs: number;
  readonly #pressure: (group: unknown) => Pressure;
  readonly #refused: (group: unknown, why: Refusal, cap: CapName) => void;
  readonly #groups = new Map<unknown, Group>();
  readonly #watched = new Map<Charge, Held>();
  // Oldest first.
  readonly #line: Waiter[] = [];
  // Of the line, relays: counted apart, against `maxRelaysWaiting`.
  #relaysWaiting = 0;
  #owned = 0;
  #ownedLong = 0;
  #relayed = 0;
  #relayedLong = 0;
  #scheduled = false;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: BudgetOptions = {}) {
    this.streams = opts.streams ?? POD_STREAMS;
    this.relays = opts.relays ?? 0;
    if (!(this.streams >= 1) || !(this.relays >= 0)) {
      throw new RangeError("a tunnel budget needs at least one stream");
    }
    this.longStreams = Math.floor(this.streams * LONG_SHARE);
    this.longRelays = Math.floor(this.relays * LONG_SHARE);
    this.maxWaiting = opts.waiting ?? POD_WAITING;
    this.maxRelaysWaiting = opts.relayWaiting ??
      Math.floor(this.maxWaiting * this.relays / this.streams);
    this.now = opts.now ?? Date.now;
    this.pacer = new Pacer({ now: this.now, ...opts.pace });
    this.#waitMs = opts.waitMs ?? WAIT_MS;
    this.#pressure = opts.pressure ?? (() => "normal");
    this.#refused = opts.refused ?? (() => {});
  }

  /** Streams open now, relays included. */
  get open(): number {
    return this.#watched.size;
  }

  /** Of them, long-lived ones, relays included. */
  get long(): number {
    return this.#ownedLong + this.#relayedLong;
  }

  /** Of them, relays. */
  get relayed(): number {
    return this.#relayed;
  }

  /** Requests waiting now, across every group, relays included. */
  get waiting(): number {
    return this.#line.length;
  }

  /** Of them, relays. */
  get relaysWaiting(): number {
    return this.#relaysWaiting;
  }

  /** What every group with anything open or in line holds now. */
  usage(): Map<unknown, GroupUsage> {
    const out = new Map<unknown, GroupUsage>();
    for (const [key, group] of this.#groups) {
      out.set(key, {
        open: group.open,
        waiting: group.waiting + group.waitingLong,
        buffered: 0,
        holding: 0,
        overhead: 0,
      });
    }
    for (const [charge, held] of this.#watched) {
      const one = out.get(held.key);
      const buffered = charge.buffered();
      if (one === undefined || buffered <= 0) continue;
      one.buffered += buffered;
      one.holding++;
      one.overhead += overhead(charge);
    }
    return out;
  }

  /** Streams `group` holds open now. */
  openBy(group: unknown): number {
    return this.#groups.get(group)?.open ?? 0;
  }

  /**
   * A stream's charge for `group`, handed to `use` the moment there is one: at once when every cap
   * has room and none of the group's own requests of the same kind (short or long-lived) is ahead
   * in line, else after waiting its turn. Rejects at once under memory pressure, when the group's
   * line for its kind is full or the group holds its share of the process's, and once its wait
   * passes or `signal` aborts while it waits.
   */
  acquire<T>(group: unknown, opts: Acquire<T>): Promise<T> {
    const { signal } = opts;
    if (signal?.aborted) return Promise.reject(reason(signal));
    const pressure = this.#pressure(group);
    if (pressure !== "normal") {
      this.#refused(group, "memory", `memory-${pressure}`);
      return Promise.reject(busy());
    }
    const own = this.#group(group, opts.cap);
    const need: Need = {
      group: own,
      long: opts.long ?? false,
      relay: opts.relay ?? false,
      ready: opts.ready ?? (() => true),
    };
    const ahead = need.long ? own.waitingLong : own.waiting;
    if (ahead === 0 && this.#blocker(need) === null) {
      const charge = this.#charge(group, need);
      try {
        return Promise.resolve(opts.use(charge));
      } catch (error) {
        charge.release();
        return Promise.reject(error);
      }
    }
    const full = this.#lineFull(own, need.long, need.relay);
    if (full !== null) {
      this.#forget(group, own);
      this.#refused(group, "line full", full);
      return Promise.reject(busy());
    }
    const count = (by: number) => {
      if (need.long) own.waitingLong += by;
      else own.waiting += by;
      if (need.relay) this.#relaysWaiting += by;
    };
    return new Promise<T>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abandoned);
      };
      const leave = (error: Error) => {
        const at = this.#line.indexOf(waiter);
        if (at < 0) return false;
        this.#line.splice(at, 1);
        count(-1);
        this.#forget(group, own);
        done();
        reject(error);
        return true;
      };
      const waiter: Waiter = {
        ...need,
        key: group,
        grant(charge) {
          count(-1);
          done();
          try {
            resolve(opts.use(charge));
          } catch (error) {
            charge.release();
            reject(error);
          }
        },
        shed: (cap) => {
          if (leave(busy())) this.#refused(group, "memory", cap);
        },
      };
      const abandoned = () => leave(reason(signal!));
      const timer = setTimeout(() => {
        const cap = this.#blocker(waiter) ?? "pod";
        if (leave(busy())) this.#refused(group, "wait expired", cap);
      }, Math.max(0, Math.min(opts.waitMs ?? this.#waitMs, this.#waitMs)));
      signal?.addEventListener("abort", abandoned, { once: true });
      this.#line.push(waiter);
      count(1);
      // A request for a tunnel with room, behind its run's requests for a full one, goes at once.
      this.#schedule();
    });
  }

  /**
   * Which line refuses a request of `own`'s now, or null when it may wait: its group's for its
   * kind, or its part's (the runs this process owns, or its relays: neither ever takes the
   * other's places) when full. Within its floor (LINE_FLOOR, at most its cap) a group is refused
   * by nothing else. Past it, also when its part's line has reached what the floors leave
   * (LINE_RESERVE short of full), or the group already holds half of what the others leave of
   * that. Half of what is left, never a fixed share: each group that fills its part halves what
   * the next may take, so no few groups ever fill the line between them, and the reserve is only
   * ever floors' places. Floors alone fill the line at last, as they fill the streams: a group's
   * floor is its cap's 2 places a stream (128 for a run), so the line fills at as many groups'
   * floors as the streams fill at groups' caps (twelve runs).
   */
  #lineFull(own: Group, long: boolean, relay: boolean): CapName | null {
    const ahead = long ? own.waitingLong : own.waiting;
    if (ahead >= (long ? own.cap.waitingLong : own.cap.waiting)) return `${own.cap.name}-line`;
    const line = relay ? this.#relaysWaiting : this.#line.length - this.#relaysWaiting;
    const most = relay ? this.maxRelaysWaiting : this.maxWaiting;
    const full = relay ? "pod-relay-line" : "pod-line";
    if (line >= most) return full;
    const mine = own.waiting + own.waitingLong;
    if (mine < Math.min(own.cap.waiting, LINE_FLOOR)) return null;
    const shared = most - Math.min(LINE_RESERVE, Math.floor(most / 3));
    const left = shared - (line - mine);
    if (line >= shared || mine >= Math.ceil(left / 2)) return full;
    return null;
  }

  /** Turns away every request in line of the groups `only` names: what the guard does to
   * everyone's at CRITICAL (waiting holds memory too, and nothing is granted while it lasts). */
  empty(pressure: Exclude<Pressure, "normal">, only: (group: unknown) => boolean): void {
    const cap = `memory-${pressure}`;
    for (const waiter of [...this.#line]) {
      if (only(waiter.key)) waiter.shed(cap);
    }
  }

  /**
   * What the process's guard calls while it is near its memory limit, about once a second, for
   * the groups it names (`only`): their requests in line are turned away (waiting holds memory
   * too, and nothing is granted them while the pressure lasts), and every stream of theirs that
   * holds any bytes is closed, whether or not its reader is taking them. Every one, not just
   * enough to cover a target: the pod's counter lags what closing frees by seconds, so a target
   * would be met only on news that is already stale. A stream holding nothing stays. No other
   * group's line or stream is touched. Returns how many it closed and what they held.
   */
  relieve(
    pressure: Exclude<Pressure, "normal">,
    only: (group: unknown) => boolean,
  ): { closed: number; freed: number } {
    const cap = `memory-${pressure}`;
    this.empty(pressure, only);
    const candidates = [...this.#watched]
      .filter(([, held]) => only(held.key))
      .map(([charge, held]) => ({ charge, held, buffered: charge.buffered() }))
      .filter((one) => one.buffered > 0);
    return this.#close(candidates, Infinity, Infinity, cap);
  }

  /**
   * The guard's last resort near the limit: closes streams until what they held (their unread
   * bytes either way, relays and uploads included, plus what each costs beyond them: SERVED_BYTES,
   * or STREAM_BYTES for one whose client nobody measures) reaches `bytes`, or a quarter of the
   * open streams have gone. The groups `culprit` names go first, then streams whose readers took
   * nothing since the last look, then the rest; within each, those holding the most. A stream that
   * holds nothing goes only when its group is named. Returns how many it closed and what they
   * held.
   */
  shed(
    bytes: number,
    culprit: (group: unknown) => boolean = () => false,
  ): { closed: number; freed: number } {
    const now = this.now();
    const candidates = [...this.#watched]
      .map(([charge, held]) => {
        const buffered = charge.buffered();
        const taken = charge.taken();
        const stalled = taken === held.taken;
        if (!stalled || buffered === 0) {
          held.taken = taken;
          held.since = now;
        }
        return { charge, held, buffered, stalled, named: culprit(held.key) };
      })
      .filter((one) => one.buffered > 0 || one.named)
      .sort((a, b) =>
        Number(b.named) - Number(a.named) || Number(b.stalled) - Number(a.stalled) ||
        b.buffered - a.buffered
      );
    const most = Math.max(1, Math.ceil(this.#watched.size / 4));
    return this.#close(candidates, bytes, most, "memory-critical");
  }

  /** Closes `candidates` in order until what they held reaches `bytes` or `most` have gone. */
  #close(
    candidates: { charge: Charge; held: Held; buffered: number }[],
    bytes: number,
    most: number,
    cap: CapName,
  ): { closed: number; freed: number } {
    let freed = 0;
    let closed = 0;
    for (const { charge, held, buffered } of candidates) {
      if (freed >= bytes || closed >= most) break;
      // Closed by an earlier one's turn: a stream may close another's of its group with it.
      if (!this.#watched.has(charge)) continue;
      this.#refused(held.key, "memory", cap);
      charge.close();
      freed += buffered + overhead(charge);
      closed++;
    }
    return { closed, freed };
  }

  /**
   * Closes every stream whose reader has taken nothing for STALL_MS while it held bytes, when
   * closing it lets a request in line in; after each, the line is served before the next is
   * judged, so one sweep frees as many as there are requests they let in. Runs on its own every
   * few seconds while any stream is open.
   */
  sweep(): void {
    const now = this.now();
    let admits = this.#admitter();
    for (const [charge, held] of [...this.#watched]) {
      if (!this.#watched.has(charge)) continue;
      const taken = charge.taken();
      if (charge.buffered() === 0 || taken !== held.taken) {
        held.taken = taken;
        held.since = now;
        continue;
      }
      if (now - held.since < STALL_MS) continue;
      const cap = admits(held);
      if (cap === null) continue;
      this.#refused(held.key, "stalled", cap);
      charge.close();
      // Whoever it let in goes now, so the next stalled stream is judged against the line as it
      // is, not as it was.
      this.#serve();
      admits = this.#admitter();
    }
  }

  /**
   * What `admits(held)` answers until the next change to the counts or the line: the cap a request
   * in line waits on that `held`'s release would lift (one that does not fit now and would once it
   * is given back), or null when there is none. Worked out once per kind of release, not once per
   * stalled stream: for requests of other groups what a release lifts depends on its part (relay
   * or not) and whether it is long-lived alone, and for its own group's on the group too; and
   * which requests fit now is asked of each once, when the first stalled stream is judged.
   */
  #admitter(): (held: Held) => CapName | null {
    let blocked: { waiter: Waiter; cap: CapName }[] | undefined;
    const waiting = () =>
      blocked ??= this.#line.flatMap((waiter) => {
        const cap = this.#blocker(waiter);
        return cap === null ? [] : [{ waiter, cap }];
      });
    let byGroup: Map<Group, { waiter: Waiter; cap: CapName }[]> | undefined;
    const waitingOf = (group: Group) => {
      if (byGroup === undefined) {
        byGroup = new Map();
        for (const one of waiting()) {
          const of = byGroup.get(one.waiter.group);
          if (of === undefined) byGroup.set(one.waiter.group, [one]);
          else of.push(one);
        }
      }
      return byGroup.get(group) ?? [];
    };
    // Per kind of release, the requests of other groups it lets in: two of different groups at
    // most, which is enough to know whether one is not of the releasing group.
    const others = new Map<string, { group: Group; cap: CapName }[]>();
    const own = new Map<Group, Map<string, CapName | null>>();
    const nobody = { group: null as unknown as Group };
    return (held) => {
      const kind = `${held.relay} ${held.long}`;
      let found = others.get(kind);
      if (found === undefined) {
        found = [];
        const release = { ...held, ...nobody };
        for (const { waiter, cap } of waiting()) {
          if (found.length === 2) break;
          if (found[0]?.group === waiter.group) continue;
          if (this.#blocker(waiter, release) === null) found.push({ group: waiter.group, cap });
        }
        others.set(kind, found);
      }
      const other = found.find((one) => one.group !== held.group);
      if (other !== undefined) return other.cap;
      let mine = own.get(held.group);
      if (mine === undefined) own.set(held.group, mine = new Map());
      if (!mine.has(kind)) {
        const lifted = waitingOf(held.group).find(({ waiter }) =>
          this.#blocker(waiter, held) === null
        );
        mine.set(kind, lifted?.cap ?? null);
      }
      return mine.get(kind)!;
    };
  }

  /**
   * The first cap `need` does not fit now, or once `freed` is given back; null when it fits them
   * all. A request whose tunnel is not `ready` is counted as fitting once a stream of its own
   * group is freed: a tunnel is full only at MAX_STREAMS, a run's whole cap (PER_RUN.open, which
   * `budget_test.ts` pins to MAX_STREAMS), so every stream its group holds is that tunnel's.
   */
  #blocker(need: Need, freed?: Held): CapName | null {
    const own = need.group;
    const same = freed?.group === own;
    const back = (counts: boolean | undefined) => (counts ? 1 : 0);
    const part = freed !== undefined && freed.relay === need.relay;
    if (own.open - back(same) + 1 > own.cap.open) return own.cap.name;
    if (need.long && own.long - back(same && freed?.long) + 1 > own.cap.long) {
      return `${own.cap.name}-long`;
    }
    if (need.relay) {
      if (this.#relayed - back(part) + 1 > this.relays) return "pod-relay";
      if (need.long && this.#relayedLong - back(part && freed?.long) + 1 > this.longRelays) {
        return "pod-long";
      }
    } else {
      if (this.#owned - back(part) + 1 > this.streams) return "pod";
      if (need.long && this.#ownedLong - back(part && freed?.long) + 1 > this.longStreams) {
        return "pod-long";
      }
    }
    return same || need.ready() ? null : "tunnel";
  }

  /** Adds `by` to every count `held` is in. */
  #count(held: Held, by: number) {
    held.group.open += by;
    if (held.long) held.group.long += by;
    if (held.relay) {
      this.#relayed += by;
      if (held.long) this.#relayedLong += by;
    } else {
      this.#owned += by;
      if (held.long) this.#ownedLong += by;
    }
  }

  #charge(key: unknown, need: Need): Charge {
    const own = need.group;
    let released = false;
    const held: Held = {
      key,
      group: own,
      long: need.long,
      relay: need.relay,
      taken: 0,
      since: this.now(),
    };
    const charge: Charge = {
      buffered: () => 0,
      taken: () => 0,
      close: () => charge.release(),
      promote: () => {
        if (released || held.long) return held.long;
        const longs = held.relay ? this.#relayedLong : this.#ownedLong;
        const most = held.relay ? this.longRelays : this.longStreams;
        if (own.long + 1 > own.cap.long || longs + 1 > most) return false;
        // Moved, not added: only the long-lived counts grow.
        own.long++;
        if (held.relay) this.#relayedLong++;
        else this.#ownedLong++;
        held.long = true;
        return true;
      },
      release: () => {
        if (released) return;
        released = true;
        this.#count(held, -1);
        this.#watched.delete(charge);
        this.#forget(key, own);
        if (this.#watched.size === 0) {
          clearInterval(this.#timer);
          this.#timer = undefined;
        }
        this.#schedule();
      },
    };
    this.#count(held, 1);
    this.#watched.set(charge, held);
    if (this.#timer === undefined) {
      this.#timer = setInterval(() => this.sweep(), SWEEP_MS);
      // It must not keep a process alive that is otherwise done.
      (this.#timer as { unref?: () => void }).unref?.();
    }
    return charge;
  }

  /** Serves the line once whatever is running now is done: a release runs inside the stream's
   * own destroy, and a request is put in line inside the code that is still deciding. */
  #schedule() {
    if (this.#scheduled || this.#line.length === 0) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#serve();
    });
  }

  /** Hands out what there is room for, oldest request first; one whose own caps are full stays,
   * and does not hold up those behind it. Nothing to a group under memory pressure. */
  #serve() {
    for (let i = 0; i < this.#line.length;) {
      const waiter = this.#line[i];
      if (this.#pressure(waiter.key) !== "normal" || this.#blocker(waiter) !== null) {
        i++;
        continue;
      }
      this.#line.splice(i, 1);
      waiter.grant(this.#charge(waiter.key, waiter));
    }
  }

  #group(key: unknown, cap: Cap = PER_RUN): Group {
    let group = this.#groups.get(key);
    if (group === undefined) {
      group = { cap, open: 0, long: 0, waiting: 0, waitingLong: 0 };
      this.#groups.set(key, group);
    }
    return group;
  }

  #forget(key: unknown, group: Group) {
    if (group.open === 0 && group.waiting === 0 && group.waitingLong === 0) {
      this.#groups.delete(key);
    }
  }
}

function reason(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.name !== "AbortError"
    ? signal.reason
    : new Error("request abandoned");
}

let shared: Budget | undefined;

/** The process's own budget, for tunnels not handed one. */
export function sharedBudget(): Budget {
  return shared ??= new Budget();
}
