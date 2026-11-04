// What every live channel shares: a room per run fed by one uplink, a mailbox per viewer that
// decides what a slow one may miss, and the registry that holds rooms within a count and lets
// them expire. A channel (core/live.ts the browser, core/commands.ts background commands) brings
// only its kind: what a room holds, how an uplink resets it, how a line lands, and its snapshot.
// Pure — no timers, no I/O, the clock injected.
//
// Invariants (each channel's header says what they mean for it):
// - one uplink per run: a second one replaces the first (its signal aborts), and the replaced one
//   can no longer write, so a runner that reconnected never races its own dead connection.
// - opening an uplink resets the room the kind's way, and every viewer is sent a fresh snapshot
//   of the reset room, which replaces what it had, before the new uplink's replay refills it.
// - a snapshot supersedes whatever a viewer still had queued before it, so a stalled viewer holds
//   at most one, however many uplinks come and go.
// - rooms expire `expiryMs` after their uplink closes or their run concludes, and there is a cap
//   on how many are held; at the cap the soonest-expiring idle room is evicted, and a room with a
//   live uplink never is — a new uplink is refused instead.
// - per-viewer backpressure: an event the kind names as coalescing keeps only its latest in a
//   viewer's queue; everything else queues up to a count and a byte cap, dropping the oldest and
//   telling the viewer how many it lost (`dropped`) — except what the kind names as kept, which a
//   viewer never misses.
// - at most MAX_VIEWERS viewers per run and channel, and of those MAX_VIEWERS_PER_PRINCIPAL per
//   principal: a further one is refused, so one run's page left open in many tabs (or a script)
//   cannot hold the process's memory hostage, nor one reader lock the others out.
// - viewers are kept apart from rooms: a viewer may wait on a run whose uplink has not opened
//   yet, and a room expiring is not the run ending. Only a conclusion says `done` — the host's
//   signal, or the host's word that the run is terminal when a viewer opens or keeps alive.
// - the snapshot is built once per room state and shared by every viewer that opens on it.
// - nothing here sweeps on a timer: expiry is checked whenever a room or viewer is touched, and
//   by whoever calls `sweep()`.

/** What every channel's viewer may be sent, besides its kind's own events. */
export type RoomOut<Snapshot> =
  | { event: "snapshot"; data: Snapshot }
  | { event: "uplink"; data: { connected: boolean } }
  /** The viewer fell behind and this many queued events were dropped, oldest first. */
  | { event: "dropped"; data: { count: number } }
  /** The run concluded: nothing more will ever arrive. */
  | { event: "done"; data: Record<string, never> };

export interface RoomUplink<Event> {
  /** Applies one event to the room and fans it out. False when it was not applied: this uplink
   * is not current, or the kind refused the event. */
  push(event: Event): boolean;
  /** The connection ended. Starts the room's expiry clock if this was still the current uplink. */
  close(): void;
  /** Aborted when this uplink is replaced by a newer one or the run concludes: stop reading.
   * Its `reason` says which: CONCLUDED or REPLACED. */
  readonly signal: AbortSignal;
}

/** The abort reason of an uplink hung up because its run concluded. */
export const CONCLUDED = "concluded";
/** The abort reason of an uplink a newer one replaced. */
export const REPLACED = "replaced";

export interface RoomViewer<Out> {
  /** The next thing to send, or null when nothing is waiting (or the viewer has finished). */
  take(): Out | null;
  /** Resolves once `take()` has something, or the viewer is finished. */
  ready(): Promise<void>;
  /** True once `done` was taken or the viewer left: nothing more will come. */
  readonly finished: boolean;
  /** Detach. Idempotent; wakes a pending `ready()`. */
  leave(): void;
}

export interface Rooms<Event, Out> {
  /** "concluded" for a run known to be over, "full" at the cap with every room live. */
  openUplink(runId: string): RoomUplink<Event> | "concluded" | "full";
  /**
   * Attach a viewer: its first item is the snapshot. `terminal` is the host's word that the run
   * is already over — with no room left to show, the viewer gets an empty snapshot and `done`.
   * "full" when the run already has `maxViewers`, or `principal` (who is watching, as the host
   * knows them) already holds `maxViewersPerPrincipal` of them.
   */
  watch(
    runId: string,
    opts?: { terminal?: boolean; principal?: string },
  ): RoomViewer<Out> | "full";
  /** The run reached a terminal state: hang up its uplink, say `done` to its viewers. */
  conclude(runId: string): void;
  /** Drop every room past its expiry. */
  sweep(): void;
  /** How many rooms are held — for tests and diagnostics. */
  size(): number;
}

/** Fans one item out to the room's viewers, with its estimated size in bytes. */
export type Broadcast<Out> = (out: Out, bytes?: number) => void;

/** A channel: what its rooms hold and how its lines land. `State` is mutable and the kind's. */
export interface RoomKind<State, Event, Snapshot, Out> {
  create(): State;
  /** A new uplink is open: empty what its replay will refill. */
  reset(state: State): void;
  /** The whole of the room, for a viewer opening or after a reset. Built at most once per
   * state; `uplink` says whether one is connected. */
  snapshot(state: State | null, uplink: boolean): Snapshot;
  /** Applies one line and fans out what viewers see of it. False refuses the line: nothing
   * changed and nothing was sent. */
  apply(state: State, event: Event, broadcast: Broadcast<Out>): boolean;
  /** An event a viewer keeps only the latest of (a browser frame), if any. */
  coalesce?: string;
  /** Events a slow viewer is never made to miss, as it never misses a snapshot or `done`: the
   * kind bounds how many it sends between two snapshots. */
  keep?: readonly string[];
}

export interface RoomLimits {
  now?: () => number;
  expiryMs?: number;
  maxRooms?: number;
  /** Non-coalescing events a viewer may have waiting before the oldest is dropped. */
  viewerQueue?: number;
  /** What a viewer's queue may hold besides its coalesced event and its snapshot, in bytes. */
  viewerBudget?: number;
  /** Viewers one run may have at once; a further one is refused. */
  maxViewers?: number;
  /** Of those, how many one principal may hold, so one reader cannot lock the others out. */
  maxViewersPerPrincipal?: number;
}

/** The estimate for anything with no strings worth counting: a status, `uplink`, `done`. */
export const SMALL = 64;
/** Per-object overhead on top of its strings: keys, numbers, punctuation. */
export const OVERHEAD = 128;

/** Where a pending coalesced event sits in a viewer's queue — the event itself is held beside
 * it, so a newer one replaces it without moving the slot or growing the queue. */
const COALESCED_SLOT = Symbol("coalesced");

interface Queued<Out> {
  out: Out;
  /** Estimated bytes; 0 for the snapshot, which is shared and never dropped. */
  bytes: number;
}

type AnyOut = { event: string; data: unknown };

class Mailbox<Out extends AnyOut> implements RoomViewer<Out> {
  private queue: Array<Queued<Out> | typeof COALESCED_SLOT> = [];
  private coalesced: Out | null = null;
  /** Non-coalesced items queued and their estimated bytes — what the caps count. */
  private queued = 0;
  private queuedBytes = 0;
  private dropped = 0;
  private ending = false;
  private wake: (() => void) | null = null;
  finished = false;

  constructor(
    private readonly cap: number,
    private readonly budget: number,
    private readonly coalesce: string | undefined,
    private readonly keep: ReadonlySet<string>,
    private readonly onLeave: () => void,
  ) {}

  deliver(out: Out, bytes = SMALL): void {
    if (this.ending || this.finished) return;
    if (out.event === "snapshot") {
      // The whole of the room: what was queued before it, lost lines included, is all in it or
      // gone from the room too.
      this.queue = [];
      this.coalesced = null;
      this.queued = 0;
      this.queuedBytes = 0;
      this.dropped = 0;
    }
    if (this.coalesce !== undefined && out.event === this.coalesce) {
      if (this.coalesced === null) this.queue.push(COALESCED_SLOT);
      this.coalesced = out;
    } else {
      const cost = out.event === "snapshot" ? 0 : bytes;
      this.queue.push({ out, bytes: cost });
      this.queued++;
      this.queuedBytes += cost;
      if (out.event === "done") this.ending = true;
      else {
        while (this.queued > this.cap || this.queuedBytes > this.budget) {
          if (!this.dropOldest()) break;
        }
      }
    }
    this.notify();
  }

  /** Drops the oldest droppable item: never the snapshot (the viewer would have nothing to draw
   * the rest onto), never `done`, and never an event the kind keeps. False when there is nothing
   * left to drop. */
  private dropOldest(): boolean {
    const index = this.queue.findIndex((item) =>
      item !== COALESCED_SLOT && item.out.event !== "snapshot" && item.out.event !== "done" &&
      !this.keep.has(item.out.event)
    );
    if (index === -1) return false;
    const [item] = this.queue.splice(index, 1) as Queued<Out>[];
    this.queued--;
    this.queuedBytes -= item.bytes;
    this.dropped++;
    return true;
  }

  take(): Out | null {
    if (this.finished) return null;
    const head = this.queue[0];
    // The gap is noted where it is: after the snapshot, before whatever survived it.
    if (
      this.dropped > 0 && head !== undefined &&
      (head === COALESCED_SLOT || head.out.event !== "snapshot")
    ) {
      const count = this.dropped;
      this.dropped = 0;
      return { event: "dropped", data: { count } } as Out;
    }
    const item = this.queue.shift();
    if (item === undefined) return null;
    if (item === COALESCED_SLOT) {
      const out = this.coalesced!;
      this.coalesced = null;
      return out;
    }
    this.queued--;
    this.queuedBytes -= item.bytes;
    if (item.out.event === "done") this.finish();
    return item.out;
  }

  ready(): Promise<void> {
    if (this.finished || this.queue.length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const previous = this.wake;
      this.wake = () => {
        previous?.();
        resolve();
      };
    });
  }

  leave(): void {
    if (this.finished) return;
    this.finish();
  }

  private finish(): void {
    this.finished = true;
    this.queue = [];
    this.coalesced = null;
    this.onLeave();
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

interface Room<State, Snapshot> {
  state: State;
  /** The snapshot of the current state, shared by viewers until anything changes. */
  snapshot: Snapshot | null;
  uplink: AbortController | null;
  concluded: boolean;
  /** Null while an uplink is connected; otherwise when the room may be dropped. */
  expiresAt: number | null;
}

export const EXPIRY_MS = 15 * 60_000;
export const MAX_ROOMS = 256;
/** Non-coalescing events a viewer may have waiting before the oldest is dropped. */
export const VIEWER_QUEUE = 1_000;
/** What a viewer's queue may hold besides its coalesced event (and its snapshot, which is
 * shared). */
export const VIEWER_BUDGET = 4 * 1024 * 1024;
/** Viewers one run may have at once, per channel. */
export const MAX_VIEWERS = 32;
/** Of those, how many one principal may hold. */
export const MAX_VIEWERS_PER_PRINCIPAL = 4;

/** At least `text`'s length in UTF-8 bytes, counted without encoding it: exact, but for a
 * surrogate, counted as three (a lone one is sent as U+FFFD, three bytes; a pair is four). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  return bytes;
}

export function makeRooms<State, Event, Snapshot, Out extends AnyOut>(
  kind: RoomKind<State, Event, Snapshot, Out>,
  opts: RoomLimits = {},
): Rooms<Event, Out | RoomOut<Snapshot>> {
  type AllOut = Out | RoomOut<Snapshot>;
  const now = opts.now ?? Date.now;
  const expiryMs = opts.expiryMs ?? EXPIRY_MS;
  const maxRooms = opts.maxRooms ?? MAX_ROOMS;
  const viewerQueue = opts.viewerQueue ?? VIEWER_QUEUE;
  const viewerBudget = opts.viewerBudget ?? VIEWER_BUDGET;
  const maxViewers = opts.maxViewers ?? MAX_VIEWERS;
  const maxPerPrincipal = opts.maxViewersPerPrincipal ?? MAX_VIEWERS_PER_PRINCIPAL;
  /** Viewers held per (run, principal), for the sub-cap. */
  const held = new Map<string, number>();
  const keep: ReadonlySet<string> = new Set(kind.keep ?? []);

  const rooms = new Map<string, Room<State, Snapshot>>();
  const viewers = new Map<string, Set<Mailbox<AllOut>>>();

  const broadcast = (runId: string, out: AllOut, bytes = SMALL): void => {
    // Copy: a `done` detaches each mailbox from the set being walked.
    for (const viewer of [...(viewers.get(runId) ?? [])]) viewer.deliver(out, bytes);
  };

  /** One object per room state: every viewer opening on it shares it (and so, in the stream
   * route, its serialization). */
  const snapshotOf = (room: Room<State, Snapshot>): Snapshot =>
    room.snapshot ??= kind.snapshot(room.state, room.uplink !== null);

  const sweep = (): void => {
    const at = now();
    for (const [runId, room] of rooms) {
      if (room.expiresAt !== null && room.expiresAt <= at) rooms.delete(runId);
    }
  };

  /** Room for a new uplink, making space at the cap by evicting the idle room nearest expiry. */
  const roomFor = (runId: string): Room<State, Snapshot> | null => {
    const existing = rooms.get(runId);
    if (existing) return existing;
    sweep();
    if (rooms.size >= maxRooms) {
      let victim: [string, number] | null = null;
      for (const [id, room] of rooms) {
        if (room.expiresAt !== null && (victim === null || room.expiresAt < victim[1])) {
          victim = [id, room.expiresAt];
        }
      }
      if (victim === null) return null;
      rooms.delete(victim[0]);
    }
    const room: Room<State, Snapshot> = {
      state: kind.create(),
      snapshot: null,
      uplink: null,
      concluded: false,
      expiresAt: null,
    };
    rooms.set(runId, room);
    return room;
  };

  const conclude = (runId: string): void => {
    const room = rooms.get(runId);
    if (room !== undefined && !room.concluded) {
      room.concluded = true;
      room.expiresAt = now() + expiryMs;
      if (room.uplink !== null) {
        room.uplink.abort(CONCLUDED);
        room.uplink = null;
        room.snapshot = null;
        broadcast(runId, { event: "uplink", data: { connected: false } });
      }
    }
    broadcast(runId, { event: "done", data: {} });
  };

  return {
    openUplink(runId) {
      const known = rooms.get(runId);
      if (known?.concluded) return "concluded";
      const room = roomFor(runId);
      if (room === null) return "full";
      room.uplink?.abort(REPLACED);
      const controller = new AbortController();
      room.uplink = controller;
      room.expiresAt = null;
      // The new uplink replays its producer's recent lines first thing, so the kind empties what
      // that replay refills: kept, every replayed line would be held (and shown) twice. Viewers
      // get the reset room as a snapshot — the one message that replaces what they had — which
      // also says the uplink is connected.
      kind.reset(room.state);
      room.snapshot = null;
      broadcast(runId, { event: "snapshot", data: snapshotOf(room) });
      const current = () => room.uplink === controller && rooms.get(runId) === room;
      const send: Broadcast<Out> = (out, bytes) => broadcast(runId, out, bytes);
      return {
        signal: controller.signal,
        push(event) {
          if (!current()) return false;
          room.snapshot = null;
          return kind.apply(room.state, event, send);
        },
        close() {
          if (!current()) return;
          room.uplink = null;
          room.snapshot = null;
          room.expiresAt = now() + expiryMs;
          broadcast(runId, { event: "uplink", data: { connected: false } });
        },
      };
    },

    watch(runId, watchOpts = {}) {
      sweep();
      const room = rooms.get(runId);
      let set = viewers.get(runId);
      if (set !== undefined && set.size >= maxViewers) return "full";
      const principalKey = `${runId}\u0000${watchOpts.principal ?? ""}`;
      const holding = held.get(principalKey) ?? 0;
      if (holding >= maxPerPrincipal) return "full";
      held.set(principalKey, holding + 1);
      if (set === undefined) {
        set = new Set();
        viewers.set(runId, set);
      }
      const own = set;
      const mailbox: Mailbox<AllOut> = new Mailbox<AllOut>(
        viewerQueue,
        viewerBudget,
        kind.coalesce,
        keep,
        () => {
          const left = (held.get(principalKey) ?? 1) - 1;
          if (left <= 0) held.delete(principalKey);
          else held.set(principalKey, left);
          own.delete(mailbox);
          if (own.size === 0 && viewers.get(runId) === own) viewers.delete(runId);
        },
      );
      own.add(mailbox);
      mailbox.deliver({
        event: "snapshot",
        data: room ? snapshotOf(room) : kind.snapshot(null, false),
      });
      // Over already: what is left to see is in the snapshot, and nothing will follow it. The
      // host's word that the run is terminal counts even when the room never heard a conclusion
      // (a NOTIFY lost between replicas, a ping that failed past its retries): it concludes the
      // room now.
      if (room?.concluded) mailbox.deliver({ event: "done", data: {} });
      else if (watchOpts.terminal) conclude(runId);
      return mailbox;
    },

    conclude,

    sweep,
    size: () => rooms.size,
  };
}
