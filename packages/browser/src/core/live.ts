// THE LIVE STREAM, as the sidecar produces it: the event shapes (a contract with the runner's
// relay, the historian's LiveRoom and the app's pane), the rules
// that shape them, and the hub that hands them to the one consumer.
//
// Ephemeral by design. Nothing here is a record: the durable account of what the agent did is the
// transcript's tool calls. What IS kept is what a newcomer needs to draw the pane at once — status,
// tabs, the latest frame, which the first line of every connection carries — and bounded rings of
// the recent console, network and action lines, replayed after it. A relay reconnects (a
// historian redeploy, a network blip) and the historian takes a new uplink's lines as the whole
// of the run's recent history, so a consumer that got only the snapshot would empty the pane's
// lists for the rest of the run.

export type LiveStatus = "idle" | "launching" | "active" | "closed";
export type ConsoleLevel = "debug" | "log" | "info" | "warn" | "error";

export interface Tab {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface Frame {
  mime: "image/jpeg";
  /** Base64 JPEG. */
  data: string;
  /** The JPEG's own pixel size. */
  width: number;
  height: number;
  tabId: string;
  /** The tab's viewport in CSS pixels, which an action's `target` is measured in. */
  viewport: { width: number; height: number };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LiveEvent =
  | { type: "snapshot"; at: number; status: LiveStatus; tabs: Tab[]; frame: Frame | null }
  | { type: "frame"; at: number; frame: Frame }
  | { type: "tabs"; at: number; tabs: Tab[] }
  | {
    type: "console";
    at: number;
    tabId: string;
    level: ConsoleLevel;
    text: string;
    source?: { url: string; line?: number };
    exception?: true;
  }
  | {
    type: "network";
    at: number;
    tabId: string;
    method: string;
    url: string;
    resourceType: string;
    status?: number;
    failure?: string;
    durationMs?: number;
  }
  | { type: "action"; at: number; tool: string; summary: string; target?: Rect }
  | { type: "status"; at: number; status: LiveStatus };

/** One console line on the stream, at most this long. */
export const CONSOLE_TEXT_CAP = 2 * 1024;
/** A URL on the stream, at most this long (a data: URL would otherwise be a whole image). */
export const URL_CAP = 2 * 1024;
/** An action's summary, at most this long. */
export const SUMMARY_CAP = 300;
/** A request's failure text, at most this long. */
export const FAILURE_CAP = 300;

/**
 * How many of each transient kind the hub keeps for the next consumer: the historian's own ring
 * sizes, so a replay refills its room exactly and no more.
 */
export const REPLAY_RINGS = { console: 500, network: 200, action: 200 } as const;

const LEVEL_ORDER: ConsoleLevel[] = ["debug", "log", "info", "warn", "error"];

export function levelRank(level: ConsoleLevel): number {
  return LEVEL_ORDER.indexOf(level);
}

export function isConsoleLevel(value: string): value is ConsoleLevel {
  return (LEVEL_ORDER as string[]).includes(value);
}

/**
 * Playwright's console message type, in the stream's five levels. `warning` is the one rename;
 * the rest of the long tail (`dir`, `table`, `trace`, `assert`, `count`, timers …) are what a
 * page logs, so they read as `log` — except `assert`, which is a failure the page reported.
 */
export function consoleLevel(type: string): ConsoleLevel {
  switch (type) {
    case "debug":
    case "info":
    case "error":
      return type;
    case "warning":
      return "warn";
    case "assert":
      return "error";
    default:
      return "log";
  }
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max - 1;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

/** The request kinds the stream (and `network_requests` by default) carry; failures always go. */
export const INTERESTING_RESOURCES = new Set(["document", "xhr", "fetch"]);

export function networkWanted(resourceType: string, failed: boolean): boolean {
  return failed || INTERESTING_RESOURCES.has(resourceType);
}

/**
 * The pixel size of a baseline or progressive JPEG, read from its first SOF marker; null when
 * the bytes are not one. A screencast frame's metadata says the DEVICE size, not the encoded
 * size (which `maxWidth`/`maxHeight` and the device scale factor change), and the app scales
 * an action's target from one to the other, so the encoded size is measured, not assumed.
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    // Fill bytes and the markers that carry no length.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    // SOF0..SOF15, minus DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return { width, height };
    }
    i += 2 + length;
  }
  return null;
}

/** Decodes only as much base64 as the header needs: a frame's SOF sits in its first few hundred bytes. */
export function jpegSizeOfBase64(
  data: string,
  headBytes = 4096,
): { width: number; height: number } | null {
  const chars = Math.min(data.length, Math.ceil(headBytes / 3) * 4);
  try {
    const bin = atob(data.slice(0, chars - (chars % 4)));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return jpegSize(bytes);
  } catch {
    return null;
  }
}

type Transient = Extract<LiveEvent, { type: "console" | "network" | "action" }>;

/**
 * A transient event as the hub keeps it: every free-text string clipped to its cap. The adapter
 * already clips what it emits; doing it again here (a no-op then) is what makes the rings' size a
 * property of the hub rather than of its callers — at most about 2.6 MB of strings in all.
 */
function retained(event: Transient): Transient {
  switch (event.type) {
    case "console": {
      const kept = { ...event, text: clip(event.text, CONSOLE_TEXT_CAP) };
      if (event.source) kept.source = { ...event.source, url: clip(event.source.url, URL_CAP) };
      return kept;
    }
    case "network": {
      const kept = { ...event, url: clip(event.url, URL_CAP) };
      if (event.failure !== undefined) kept.failure = clip(event.failure, FAILURE_CAP);
      return kept;
    }
    case "action":
      return { ...event, summary: clip(event.summary, SUMMARY_CAP) };
  }
}

/** How many lines may wait for a slow consumer before frames are dropped, and then everything. */
const FRAME_BACKLOG = 4;
const EVENT_BACKLOG = 1000;

/**
 * The hub between the browser and the one `/live` consumer (the runner's relay). It keeps the
 * state the next `snapshot` line needs, and the newest console, network and action lines (whether
 * or not anyone is listening), which a new consumer gets straight after its snapshot, in the order
 * they happened, before anything live. A new connection REPLACES the old one — the old stream is closed — because the
 * runner reconnects after a blip and the dead half of that pair must not hold the slot.
 *
 * A consumer that stops reading must not grow this process without bound: once a few lines are
 * waiting, frames are dropped (the next one supersedes them anyway) and past a larger backlog
 * everything is, until it drains.
 */
export class LiveHub {
  #status: LiveStatus = "idle";
  #tabs: Tab[] = [];
  #frame: Frame | null = null;
  #consumer: ReadableStreamDefaultController<Uint8Array> | null = null;
  readonly #encoder = new TextEncoder();
  /** Arrival-numbered, so a replay can interleave the three rings back into one order. */
  readonly #rings: { [K in keyof typeof REPLAY_RINGS]: Array<{ n: number; event: Transient }> } = {
    console: [],
    network: [],
    action: [],
  };
  #arrivals = 0;

  constructor(private readonly now: () => number = Date.now) {}

  get status(): LiveStatus {
    return this.#status;
  }

  get tabs(): Tab[] {
    return this.#tabs;
  }

  get frame(): Frame | null {
    return this.#frame;
  }

  get attached(): boolean {
    return this.#consumer !== null;
  }

  snapshot(): LiveEvent {
    return {
      type: "snapshot",
      at: this.now(),
      status: this.#status,
      tabs: this.#tabs,
      frame: this.#frame,
    };
  }

  setStatus(status: LiveStatus): void {
    if (status === this.#status) return;
    this.#status = status;
    this.#forward({ type: "status", at: this.now(), status });
  }

  setTabs(tabs: Tab[]): void {
    if (sameTabs(tabs, this.#tabs)) return;
    this.#tabs = tabs;
    this.#forward({ type: "tabs", at: this.now(), tabs });
  }

  setFrame(frame: Frame): void {
    this.#frame = frame;
    this.#forward({ type: "frame", at: this.now(), frame });
  }

  /** Forgets the frame of a tab no longer shown, so a newcomer does not draw a stale one. */
  clearFrame(): void {
    this.#frame = null;
  }

  /** A transient event: console, network, action. Kept in its ring, and forwarded if anyone listens. */
  emit(event: Transient): void {
    const kept = retained(event);
    const ring = this.#rings[kept.type];
    ring.push({ n: this.#arrivals++, event: kept });
    if (ring.length > REPLAY_RINGS[kept.type]) ring.shift();
    this.#forward(kept);
  }

  /** What a new consumer is replayed: the three rings, oldest first across all of them. */
  replay(): Transient[] {
    const { console, network, action } = this.#rings;
    return [...console, ...network, ...action].sort((a, b) => a.n - b.n).map((held) => held.event);
  }

  /**
   * A new consumer's stream: the snapshot line, then the rings replayed, then live. Replaces any
   * earlier consumer. The replay is one chunk, so it counts as one line against the backlog and a
   * frame arriving while the consumer reads it is not taken for a stall and dropped.
   */
  attach(): ReadableStream<Uint8Array> {
    this.#detach();
    let mine: ReadableStreamDefaultController<Uint8Array> | null = null;
    return new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          mine = controller;
          this.#consumer = controller;
          controller.enqueue(this.#line(this.snapshot()));
          const replay = this.replay();
          if (replay.length > 0) {
            controller.enqueue(
              this.#encoder.encode(replay.map((e) => `${JSON.stringify(e)}\n`).join("")),
            );
          }
        },
        cancel: () => {
          if (this.#consumer === mine) this.#consumer = null;
        },
      },
      // Counted in lines: desiredSize goes negative as they pile up unread.
      { highWaterMark: 0, size: () => 1 },
    );
  }

  /** Ends the current stream, if any (at shutdown, or when a new consumer takes the slot). */
  close(): void {
    this.#detach();
  }

  #detach(): void {
    const old = this.#consumer;
    this.#consumer = null;
    if (old === null) return;
    try {
      old.close();
    } catch {
      // Already closed or errored by the client going away.
    }
  }

  #forward(event: LiveEvent): void {
    const consumer = this.#consumer;
    if (consumer === null) return;
    const waiting = -(consumer.desiredSize ?? 0);
    if (event.type === "frame" && waiting >= FRAME_BACKLOG) return;
    if (waiting >= EVENT_BACKLOG) return;
    try {
      consumer.enqueue(this.#line(event));
    } catch {
      if (this.#consumer === consumer) this.#consumer = null;
    }
  }

  #line(event: LiveEvent): Uint8Array {
    return this.#encoder.encode(`${JSON.stringify(event)}\n`);
  }
}

function sameTabs(a: Tab[], b: Tab[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) =>
    t.id === b[i].id && t.url === b[i].url && t.title === b[i].title && t.active === b[i].active
  );
}
