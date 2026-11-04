// The live channel's state: a room per run holding what a viewer needs to draw a run's browser
// RIGHT NOW, and a mailbox per viewer that decides what a slow one is allowed to miss. Pure —
// no timers, no I/O, the clock injected — so the HTTP layer drives it and the tests can too. The
// registry and the mailbox are core/rooms.ts, shared with the background commands' channel; this
// is the browser's kind of room.
//
// Invariants:
// - memory only, never persisted: the durable record of what the agent did is the transcript's
//   tool calls. A room is the latest frame, tabs, status and three bounded rings, nothing more.
// - bounded in BYTES, not just counts: the uplink's token is one the agent can read, so what it
//   sends is the agent's to choose. A room holds at most ROOM_BUDGET across its rings, frame and
//   tabs (the oldest ring entries go first), and a viewer's queue at most VIEWER_BUDGET besides
//   its coalesced frame. Sizes are estimated from string lengths, never by serializing.
// - one uplink per run: a second one replaces the first (its signal aborts), and the replaced one
//   can no longer write, so a runner that reconnected never races its own dead connection.
// - a new uplink's lines are the room's whole history: the sidecar replays its own rings of recent
//   console, network and action lines to every new consumer, so opening an uplink (first, after a
//   gap, or replacing one) empties the room's rings, and every viewer is sent a fresh snapshot of
//   the emptied room, which replaces its lists, before the replay refills them. A reconnect then
//   shows each line once, and a viewer and a newcomer agree.
// - a snapshot supersedes whatever a viewer still had queued before it, so a stalled viewer holds
//   at most one, however many uplinks come and go.
// - rooms expire EXPIRY_MS after their uplink closes or their run concludes, and there is a cap on
//   how many are held; at the cap the soonest-expiring idle room is evicted, and a room with a live
//   uplink never is — a new uplink is refused instead.
// - per-viewer backpressure: frames COALESCE (a viewer that falls behind gets the latest one,
//   never a backlog of stale pictures); everything else queues up to a cap, dropping the oldest
//   and telling the viewer how many it lost.
// - viewers are kept apart from rooms: a viewer may wait on a run whose browser has not started
//   yet, and a room expiring is not the run ending. Only a conclusion says `done` — either the
//   host's signal, or the host's word that the run is terminal when a viewer opens or keeps alive,
//   which stands in for a conclude signal that was lost.
// - the snapshot is built once per room state and shared by every viewer that opens on it.
// - nothing here sweeps on a timer: expiry is checked whenever a room or viewer is touched, and
//   by whoever calls `sweep()` (the stream route does, on every keepalive).

import {
  makeRooms,
  OVERHEAD,
  type RoomLimits,
  type RoomOut,
  type Rooms,
  type RoomUplink,
  type RoomViewer,
  SMALL,
} from "./rooms.ts";

export type LiveStatus = "idle" | "launching" | "active" | "closed";

export interface LiveTab {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface LiveFrame {
  mime: "image/jpeg";
  /** base64 */
  data: string;
  width: number;
  height: number;
  tabId: string;
  /** The active tab's viewport in CSS pixels, which an action's `target` is measured in. */
  viewport?: { width: number; height: number };
}

export type LiveConsoleEvent = {
  type: "console";
  at: number;
  tabId: string;
  level: "debug" | "log" | "info" | "warn" | "error";
  text: string;
  source?: { url: string; line?: number };
  exception?: true;
};
export type LiveNetworkEvent = {
  type: "network";
  at: number;
  tabId: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  failure?: string;
  durationMs?: number;
};
export type LiveActionEvent = {
  type: "action";
  at: number;
  tool: string;
  summary: string;
  target?: { x: number; y: number; width: number; height: number };
};

/** One line of the sidecar's `GET /live`, relayed by the runner. */
export type LiveEvent =
  | { type: "snapshot"; at: number; status: LiveStatus; tabs: LiveTab[]; frame: LiveFrame | null }
  | { type: "frame"; at: number; frame: LiveFrame }
  | { type: "tabs"; at: number; tabs: LiveTab[] }
  | LiveConsoleEvent
  | LiveNetworkEvent
  | LiveActionEvent
  | { type: "status"; at: number; status: LiveStatus };

/** Everything the room holds: what a viewer is handed first, and again whenever an uplink opens
 * (which empties the rings), to replace what it had. */
export interface LiveSnapshot {
  uplink: boolean;
  status: LiveStatus;
  tabs: LiveTab[];
  frame: LiveFrame | null;
  console: LiveConsoleEvent[];
  network: LiveNetworkEvent[];
  actions: LiveActionEvent[];
}

/** One thing to send a viewer: the SSE event name and its data. */
export type LiveOut =
  | { event: "frame" | "tabs" | "console" | "network" | "action" | "status"; data: LiveEvent }
  | RoomOut<LiveSnapshot>;

export { EXPIRY_MS, MAX_ROOMS, VIEWER_BUDGET, VIEWER_QUEUE } from "./rooms.ts";
export const CONSOLE_RING = 500;
export const NETWORK_RING = 200;
export const ACTION_RING = 200;
/** What a room may hold across its rings, latest frame and tabs, in estimated bytes. */
export const ROOM_BUDGET = 8 * 1024 * 1024;

export type LiveUplink = RoomUplink<LiveEvent>;
export type LiveViewer = RoomViewer<LiveOut>;
export type LiveRooms = Rooms<LiveEvent, LiveOut>;

interface Held<T> {
  event: T;
  bytes: number;
  /** Arrival order across all three rings, so the budget evicts the oldest whichever ring. */
  order: number;
}

interface LiveState {
  status: LiveStatus;
  tabs: LiveTab[];
  frame: LiveFrame | null;
  console: Held<LiveConsoleEvent>[];
  network: Held<LiveNetworkEvent>[];
  actions: Held<LiveActionEvent>[];
  /** Estimated bytes held: the rings, plus `frameBytes` and `tabsBytes`. */
  bytes: number;
  frameBytes: number;
  tabsBytes: number;
}

const emptySnapshot = (): LiveSnapshot => ({
  uplink: false,
  status: "idle",
  tabs: [],
  frame: null,
  console: [],
  network: [],
  actions: [],
});

const tabsBytes = (tabs: LiveTab[]): number =>
  tabs.reduce((sum, t) => sum + OVERHEAD + t.id.length + t.url.length + t.title.length, OVERHEAD);
const frameBytes = (frame: LiveFrame | null): number =>
  frame === null ? 0 : OVERHEAD + frame.data.length + frame.tabId.length;

/** An event's size, estimated from its strings' lengths — never by serializing it. */
export function liveEventBytes(event: LiveEvent): number {
  switch (event.type) {
    case "snapshot":
      return tabsBytes(event.tabs) + frameBytes(event.frame);
    case "frame":
      return frameBytes(event.frame);
    case "tabs":
      return tabsBytes(event.tabs);
    case "console":
      return OVERHEAD + event.tabId.length + event.text.length + (event.source?.url.length ?? 0);
    case "network":
      return OVERHEAD + event.tabId.length + event.method.length + event.url.length +
        event.resourceType.length + (event.failure?.length ?? 0);
    case "action":
      return OVERHEAD + event.tool.length + event.summary.length;
    case "status":
      return SMALL;
  }
}

const pushRing = <T>(state: LiveState, ring: Held<T>[], held: Held<T>, cap: number): void => {
  ring.push(held);
  state.bytes += held.bytes;
  while (ring.length > cap) state.bytes -= ring.shift()!.bytes;
};

/** Evicts the oldest ring entries, whichever ring, until the room is within its budget. */
const enforceBudget = (state: LiveState, budget: number): void => {
  while (state.bytes > budget) {
    let oldest: Held<unknown>[] | null = null;
    for (const ring of [state.console, state.network, state.actions] as Held<unknown>[][]) {
      if (ring.length > 0 && (oldest === null || ring[0].order < oldest[0].order)) oldest = ring;
    }
    if (oldest === null) return; // only the frame and tabs are left, each bounded by the schema
    state.bytes -= oldest.shift()!.bytes;
  }
};

export function makeLiveRooms(opts: RoomLimits & { roomBudget?: number } = {}): LiveRooms {
  const roomBudget = opts.roomBudget ?? ROOM_BUDGET;
  let arrivals = 0;

  const setFrame = (state: LiveState, frame: LiveFrame): number => {
    const bytes = frameBytes(frame);
    state.bytes += bytes - state.frameBytes;
    state.frameBytes = bytes;
    state.frame = frame;
    return bytes;
  };
  const setTabs = (state: LiveState, tabs: LiveTab[]): number => {
    const bytes = tabsBytes(tabs);
    state.bytes += bytes - state.tabsBytes;
    state.tabsBytes = bytes;
    state.tabs = tabs;
    return bytes;
  };

  return makeRooms<LiveState, LiveEvent, LiveSnapshot, LiveOut>({
    coalesce: "frame",
    create: () => ({
      status: "idle",
      tabs: [],
      frame: null,
      console: [],
      network: [],
      actions: [],
      bytes: 0,
      frameBytes: 0,
      tabsBytes: 0,
    }),
    // The new uplink's sidecar replays its recent lines first thing, so the old ones go. Status,
    // tabs and frame stay until its snapshot line says otherwise.
    reset(state) {
      state.console = [];
      state.network = [];
      state.actions = [];
      state.bytes = state.frameBytes + state.tabsBytes;
    },
    // Bounded by ROOM_BUDGET, because the room is.
    snapshot: (state, uplink) =>
      state === null ? emptySnapshot() : {
        uplink,
        status: state.status,
        tabs: state.tabs,
        frame: state.frame,
        console: state.console.map((held) => held.event),
        network: state.network.map((held) => held.event),
        actions: state.actions.map((held) => held.event),
      },
    apply(state, event, broadcast) {
      let bytes: number;
      switch (event.type) {
        case "snapshot": {
          // The producer's own snapshot (sent first on every connection) is the room's state
          // catching up, which viewers see as the per-type events it amounts to. A null frame
          // only says the browser has nothing new to show, so the last picture stays.
          state.status = event.status;
          const tabs = setTabs(state, event.tabs);
          if (event.frame !== null) setFrame(state, event.frame);
          enforceBudget(state, roomBudget);
          broadcast({
            event: "status",
            data: { type: "status", at: event.at, status: event.status },
          });
          broadcast(
            { event: "tabs", data: { type: "tabs", at: event.at, tabs: event.tabs } },
            tabs,
          );
          if (event.frame !== null) {
            broadcast({
              event: "frame",
              data: { type: "frame", at: event.at, frame: event.frame },
            });
          }
          return true;
        }
        case "frame":
          bytes = setFrame(state, event.frame);
          break;
        case "tabs":
          bytes = setTabs(state, event.tabs);
          break;
        case "status":
          state.status = event.status;
          bytes = SMALL;
          break;
        case "console":
          bytes = liveEventBytes(event);
          pushRing(state, state.console, { event, bytes, order: arrivals++ }, CONSOLE_RING);
          break;
        case "network":
          bytes = liveEventBytes(event);
          pushRing(state, state.network, { event, bytes, order: arrivals++ }, NETWORK_RING);
          break;
        case "action":
          bytes = liveEventBytes(event);
          pushRing(state, state.actions, { event, bytes, order: arrivals++ }, ACTION_RING);
          break;
      }
      enforceBudget(state, roomBudget);
      broadcast({ event: event.type, data: event }, bytes);
      return true;
    },
  }, opts);
}
