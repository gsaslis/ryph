import type {
  LiveAction,
  LiveConsole,
  LiveFrame,
  LiveMessage,
  LiveNetwork,
  LiveStatus,
  LiveTab,
  LiveTarget,
} from "$lib/api/browser-live";
import { bareBrowserTool } from "$lib/utils/browser-tools";

// What a viewer of a run's browser holds, and how each message off the stream moves it. Pure, so
// the pane's state class is a thin shell around it and every rule here is tested on its own.

/** The most of each list a viewer keeps: the historian's own ring sizes. */
export const CAPS = { console: 500, network: 200, actions: 200 } as const;

/** An entry with an id of the viewer's own, for keyed lists. */
export type Entry<T> = T & { id: number };

export interface LiveView {
  /** A room has been read at least once since connecting. */
  room: boolean;
  /** The historian said the run concluded and closed the stream. */
  done: boolean;
  /** Events a slow connection lost, as the historian counted them. */
  dropped: number;
  uplink: boolean;
  status: LiveStatus;
  tabs: LiveTab[];
  frame: LiveFrame | null;
  console: Entry<LiveConsole>[];
  network: Entry<LiveNetwork>[];
  actions: Entry<LiveAction>[];
  /** The newest action that pointed at something, for the ring on the viewport. */
  highlight: { id: number; target: LiveTarget } | null;
  nextId: number;
}

export function emptyView(): LiveView {
  return {
    room: false,
    done: false,
    dropped: 0,
    uplink: false,
    status: "idle",
    tabs: [],
    frame: null,
    console: [],
    network: [],
    actions: [],
    highlight: null,
    nextId: 1,
  };
}

/** A list with one more entry, the oldest dropped past the cap. */
function appended<T>(list: T[], item: T, cap: number): T[] {
  const kept = list.length >= cap ? list.slice(list.length - cap + 1) : list.slice();
  kept.push(item);
  return kept;
}

function numbered<T>(items: T[], from: number, cap: number): Entry<T>[] {
  return items.slice(-cap).map((item, i) => ({ ...item, id: from + i }));
}

/**
 * The fields one message changes, and only those. Separate fields rather than a whole new view, so
 * a frame arriving ten times a second does not wake the console list.
 */
export function applyMessage(view: LiveView, message: LiveMessage): Partial<LiveView> {
  switch (message.kind) {
    case "room": {
      const { room } = message;
      let id = view.nextId;
      const console = numbered(room.console, id, CAPS.console);
      id += console.length;
      const network = numbered(room.network, id, CAPS.network);
      id += network.length;
      const actions = numbered(room.actions, id, CAPS.actions);
      id += actions.length;
      // A room replaces everything: it is the whole of what the historian holds, and a reconnect
      // that kept the old lists would show every line twice. No highlight: the last action may be
      // minutes old, and a ring is for what just happened.
      return {
        room: true,
        uplink: room.uplink,
        status: room.status,
        tabs: room.tabs,
        frame: room.frame,
        console,
        network,
        actions,
        highlight: null,
        nextId: id,
      };
    }
    case "uplink":
      return { uplink: message.connected };
    case "dropped":
      return { dropped: view.dropped + message.count };
    case "done":
      return { done: true, uplink: false };
    case "event": {
      const event = message.event;
      const id = view.nextId;
      switch (event.type) {
        case "snapshot":
          // The sidecar's own opening line, relayed: the room's present state, not a history.
          return { status: event.status, tabs: event.tabs, frame: event.frame ?? view.frame };
        case "frame":
          return { frame: event.frame };
        case "tabs":
          return { tabs: event.tabs };
        case "status":
          return { status: event.status };
        case "console":
          return {
            console: appended(view.console, { ...event, id }, CAPS.console),
            nextId: id + 1,
          };
        case "network":
          return {
            network: appended(view.network, { ...event, id }, CAPS.network),
            nextId: id + 1,
          };
        case "action":
          return {
            actions: appended(view.actions, { ...event, id }, CAPS.actions),
            highlight: event.target ? { id, target: event.target } : view.highlight,
            nextId: id + 1,
          };
      }
    }
  }
}

/** The tab the screencast follows. */
export function activeTab(tabs: readonly LiveTab[]): LiveTab | null {
  return tabs.find((tab) => tab.active) ?? tabs[0] ?? null;
}

// ---- the status chip ----

export type Chip = "connecting" | "live" | "idle" | "ended";

/**
 * The chip over the viewport. Ended is the run over (the historian said so, or the page knows it
 * and nobody is relaying), or the browser closed;
 * live is a relay with a browser running; idle is everything in between (a browser not launched
 * yet, or a relay that dropped while the run goes on).
 */
export function chipFor(
  view: Pick<LiveView, "room" | "uplink" | "status" | "done">,
  runEnded: boolean,
): Chip {
  if (view.done || view.status === "closed" || (runEnded && !view.uplink && view.room)) {
    return "ended";
  }
  if (!view.room) return runEnded ? "ended" : "connecting";
  if (view.uplink && (view.status === "active" || view.status === "launching")) return "live";
  return "idle";
}

// ---- the highlight ring ----

/** A box in percentages of the frame, so it scales with however big the frame is drawn. */
export interface PercentBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * An action's target, in CSS pixels of the tab's viewport, as a box over the frame. The frame is
 * the viewport drawn at some other size (the JPEG is capped, and the pane is smaller still), so
 * percentages of the viewport are percentages of the frame. Clipped to it; null when nothing of
 * the target is on screen.
 */
export function highlightBox(
  target: LiveTarget,
  viewport: { width: number; height: number },
): PercentBox | null {
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  const x0 = Math.max(0, target.x);
  const y0 = Math.max(0, target.y);
  const x1 = Math.min(viewport.width, target.x + target.width);
  const y1 = Math.min(viewport.height, target.y + target.height);
  if (x1 <= x0 || y1 <= y0) return null;
  return {
    left: (x0 / viewport.width) * 100,
    top: (y0 / viewport.height) * 100,
    width: ((x1 - x0) / viewport.width) * 100,
    height: ((y1 - y0) / viewport.height) * 100,
  };
}

/**
 * The viewport a frame shows, in CSS pixels. The sidecar sends it with the frame; a frame without
 * it is taken to be drawn 1:1, which is what the default 1280×800 viewport under the 1280×800 cap
 * comes out as.
 */
export function viewportOf(frame: LiveFrame): { width: number; height: number } {
  return frame.viewport ?? { width: frame.width, height: frame.height };
}

// ---- the Actions list ----

/** A browser call from the transcript, as the Actions list needs it. */
export interface TranscriptAction {
  seq: number;
  /** Epoch ms. */
  at: number;
  /** The bare tool name (`click`). */
  tool: string;
  label: string;
  subject: string | null;
  done: boolean;
  isError: boolean;
}

export interface ActionItem {
  key: string;
  at: number;
  tool: string;
  label: string;
  subject: string | null;
  /** The transcript row it scrolls to; null for one the transcript has not got (yet). */
  seq: number | null;
  done: boolean;
  isError: boolean;
}

/**
 * How far apart a call's start (the runner's clock) and the action it caused (the sidecar's) can
 * be and still be the same thing. The sidecar names an action as it starts acting, after the call
 * reached it, so the action comes after the call: by how long the call waited behind the ones
 * before it, which a page load can stretch to its 30 s cap. The two share a pod, so the clocks
 * agree to well under the little an action is allowed to lead by.
 */
const PAIR_LEAD_MS = 250;
const PAIR_LAG_MS = 45_000;

/**
 * The transcript's browser calls and the stream's actions, as one list, oldest first, in one
 * vocabulary.
 *
 * The transcript is the record and the stream is what it has not caught up with. Every call is
 * listed in the app's own words (`describeBrowserCall`); an action is folded onto the call that
 * caused it and says nothing of its own. Only an action left over, with no call to fold onto, is
 * listed in the sidecar's words: the newest one before its tool_use lands, or an older one whose
 * part of the transcript is not loaded.
 *
 * An action folds onto the latest call of its tool that started before it and has not been taken,
 * the first of several that started together. The latest, so an action whose own call is not
 * loaded cannot reach forward and take a later call from the action that call caused — which left
 * that one over and the call listed twice, once in each vocabulary.
 */
export function mergeActions(
  calls: readonly TranscriptAction[],
  live: readonly Entry<LiveAction>[],
): ActionItem[] {
  const ordered = calls.toSorted((a, b) => a.seq - b.seq);
  const items: ActionItem[] = ordered.map((call) => ({
    key: `call-${call.seq}`,
    at: call.at,
    tool: call.tool,
    label: call.label,
    subject: call.subject,
    seq: call.seq,
    done: call.done,
    isError: call.isError,
  }));

  const taken = new Set<number>();
  for (const action of live.toSorted((a, b) => a.at - b.at)) {
    const tool = bareBrowserTool(action.tool);
    let paired = -1;
    for (let i = 0; i < ordered.length; i++) {
      const call = ordered[i];
      if (taken.has(i) || call.tool !== tool) continue;
      if (call.at > action.at + PAIR_LEAD_MS || action.at - call.at > PAIR_LAG_MS) continue;
      if (paired === -1 || call.at > ordered[paired].at) paired = i;
    }
    if (paired !== -1) {
      taken.add(paired);
      continue;
    }
    items.push({
      key: `live-${action.id}`,
      at: action.at,
      tool,
      label: action.summary,
      subject: null,
      seq: null,
      done: true,
      isError: false,
    });
  }
  // Stable, so a call and an action at the same ms keep the transcript's order.
  return items.toSorted((a, b) => a.at - b.at);
}

// ---- the Console and Network tabs ----

export type ConsoleFilter = "all" | "warn" | "error";

const RANK: Record<LiveConsole["level"], number> = { debug: 0, log: 1, info: 1, warn: 2, error: 3 };

export function filterConsole(
  lines: readonly Entry<LiveConsole>[],
  level: ConsoleFilter,
  text: string,
): Entry<LiveConsole>[] {
  const floor = level === "error" ? 3 : level === "warn" ? 2 : 0;
  const needle = text.trim().toLowerCase();
  return lines.filter((line) =>
    RANK[line.level] >= floor &&
    (needle === "" || line.text.toLowerCase().includes(needle) ||
      (line.source?.url.toLowerCase().includes(needle) ?? false))
  );
}

/** A request that did not work: it failed outright, or the server answered with an error. */
export function isFailedRequest(entry: LiveNetwork): boolean {
  return entry.failure !== undefined || (entry.status !== undefined && entry.status >= 400);
}

/** A URL without what a narrow column has no room for: the scheme, and the origin when it is the page's own. */
export function shortUrl(url: string, pageUrl: string | null): string {
  try {
    const u = new URL(url);
    const page = pageUrl === null ? null : new URL(pageUrl);
    if (page !== null && page.origin === u.origin) return `${u.pathname}${u.search}`;
    return `${u.host}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}
