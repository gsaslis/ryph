import { z } from "zod";
import { whileVisible } from "./visible-stream";

// A run's browser, live: what its sidecar's screencast, console and network capture relay through
// the historian. Nothing here is persisted anywhere — the stream is the only place it exists, and
// the durable record of what the agent did is the transcript's tool calls.

export const liveStatusSchema = z.enum(["idle", "launching", "active", "closed"]);
export type LiveStatus = z.infer<typeof liveStatusSchema>;

export const liveTabSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
});
export type LiveTab = z.infer<typeof liveTabSchema>;

const sizeSchema = z.object({ width: z.number().positive(), height: z.number().positive() });

export const liveFrameSchema = z.object({
  mime: z.string(),
  /** Base64, no `data:` prefix. */
  data: z.string(),
  /** The JPEG's own pixel size. */
  width: z.number().positive(),
  height: z.number().positive(),
  tabId: z.string(),
  /** The tab's viewport in CSS pixels, which an action's `target` is measured in. */
  viewport: sizeSchema.optional(),
});
export type LiveFrame = z.infer<typeof liveFrameSchema>;

const consoleLevel = z.enum(["debug", "log", "info", "warn", "error"]);
export type ConsoleLevel = z.infer<typeof consoleLevel>;

export const liveConsoleSchema = z.object({
  type: z.literal("console"),
  at: z.number(),
  tabId: z.string(),
  level: consoleLevel,
  text: z.string(),
  source: z.object({ url: z.string(), line: z.number().optional() }).optional(),
  exception: z.literal(true).optional(),
});
export type LiveConsole = z.infer<typeof liveConsoleSchema>;

export const liveNetworkSchema = z.object({
  type: z.literal("network"),
  at: z.number(),
  tabId: z.string(),
  method: z.string(),
  url: z.string(),
  resourceType: z.string(),
  status: z.number().optional(),
  failure: z.string().optional(),
  durationMs: z.number().optional(),
});
export type LiveNetwork = z.infer<typeof liveNetworkSchema>;

export const liveTargetSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type LiveTarget = z.infer<typeof liveTargetSchema>;

export const liveActionSchema = z.object({
  type: z.literal("action"),
  at: z.number(),
  tool: z.string(),
  summary: z.string(),
  target: liveTargetSchema.optional(),
});
export type LiveAction = z.infer<typeof liveActionSchema>;

export const liveEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    at: z.number(),
    status: liveStatusSchema,
    tabs: z.array(liveTabSchema),
    frame: liveFrameSchema.nullable(),
  }),
  z.object({ type: z.literal("frame"), at: z.number(), frame: liveFrameSchema }),
  z.object({ type: z.literal("tabs"), at: z.number(), tabs: z.array(liveTabSchema) }),
  liveConsoleSchema,
  liveNetworkSchema,
  liveActionSchema,
  z.object({ type: z.literal("status"), at: z.number(), status: liveStatusSchema }),
]);
export type LiveEvent = z.infer<typeof liveEventSchema>;

/** What the stream opens with, and opens with again after every reconnect: the room as it stands. */
export const liveRoomSchema = z.object({
  /** Whether the run's runner is relaying right now. */
  uplink: z.boolean(),
  status: liveStatusSchema,
  tabs: z.array(liveTabSchema),
  frame: liveFrameSchema.nullable(),
  console: z.array(liveConsoleSchema).default([]),
  network: z.array(liveNetworkSchema).default([]),
  actions: z.array(liveActionSchema).default([]),
});
export type LiveRoom = z.infer<typeof liveRoomSchema>;

/** Everything a stream can say, in the order it says it. */
export type LiveMessage =
  | { kind: "room"; room: LiveRoom }
  | { kind: "event"; event: LiveEvent }
  | { kind: "uplink"; connected: boolean }
  /** A slow viewer lost this many queued events (never frames, which coalesce). */
  | { kind: "dropped"; count: number }
  /** The run concluded; the stream is closed and stays closed. */
  | { kind: "done" };

/**
 * Where a viewer's messages come from. The run page hands in the historian's stream; the dev page
 * hands in a fixture. Returns the way to stop it.
 */
export type LiveSource = (handlers: {
  onMessage(message: LiveMessage): void;
  /** The stream is open (again). A room message follows. */
  onOpen?(): void;
  /** The stream dropped and is being retried. */
  onRetry?(): void;
}) => () => void;

/** The event names the historian sends besides `snapshot` and `uplink`, one per LiveEvent type. */
const EVENT_NAMES = ["frame", "tabs", "console", "network", "action", "status"] as const;

/** Reconnect delays after the stream is lost for good, in ms: quick at first, then patient. */
export const RETRY_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * The run's live browser over SSE, through the same-origin proxy and with the same `?grant=` the
 * history stream carries.
 *
 * EventSource retries a dropped connection by itself, but gives up for good on an answer that is
 * not a stream (a 404 for a room that has not opened yet, a 403 once a grant lapsed, a 502 while
 * the historian restarts). Those are retried here, on a backoff, with the grant read afresh each
 * time. Every (re)connect starts with a snapshot of the room, so nothing has to be replayed, and
 * `done` (the run concluded) ends it for good.
 *
 * The producer's own `snapshot` line never reaches a viewer as one: after the room, a sidecar that
 * snapshots again arrives as separate `status`, `tabs` and `frame` events.
 */
export function historianLiveSource(
  runId: string,
  grant: () => string | null,
  /**
   * Whether the run is over, as the page knows it. A finished run's room is dropped a while after
   * it ends, and the stream for it then never opens: that is the session having ended, not a
   * connection to keep retrying.
   */
  ended: () => boolean = () => false,
): LiveSource {
  return liveStreamSource(() => {
    const query = new URLSearchParams();
    const g = grant();
    if (g) query.set("grant", g);
    const suffix = query.size === 0 ? "" : `?${query}`;
    return `/api/v1/runs/${encodeURIComponent(runId)}/live/stream${suffix}`;
  }, ended);
}

/**
 * A live stream at any URL, read as `historianLiveSource` reads the run's. The run page goes
 * through that; the dev page uses this directly to watch a historian a local harness runs
 * (packages/browser/scripts/e2e_live.ts).
 */
export function liveStreamSource(
  url: () => string,
  ended: () => boolean = () => false,
): LiveSource {
  return ({ onMessage, onOpen, onRetry }) => {
    // One connection, with its own retries: what `whileVisible` opens while the tab is on screen
    // and closes once it has been hidden a while. Every open starts with a snapshot of the room,
    // so a reopen loses nothing.
    const connect = () => {
      let source: EventSource | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let failures = 0;
      let stopped = false;

      const open = () => {
        const es = new EventSource(url());
        source = es;
        es.addEventListener("open", () => onOpen?.());
        es.addEventListener("snapshot", (e) => {
          const room = liveRoomSchema.safeParse(parse(e));
          if (!room.success) return;
          failures = 0;
          onMessage({ kind: "room", room: room.data });
        });
        es.addEventListener("uplink", (e) => {
          const body = z.object({ connected: z.boolean() }).safeParse(parse(e));
          if (body.success) onMessage({ kind: "uplink", connected: body.data.connected });
        });
        es.addEventListener("dropped", (e) => {
          const body = z.object({ count: z.number() }).safeParse(parse(e));
          if (body.success) onMessage({ kind: "dropped", count: body.data.count });
        });
        // The run is over and the historian says so: closed for good, or EventSource would reopen
        // it forever.
        es.addEventListener("done", () => {
          stopped = true;
          stop();
          onMessage({ kind: "done" });
        });
        for (const name of EVENT_NAMES) {
          es.addEventListener(name, (e) => {
            const event = parseEvent(parse(e));
            if (event !== null) onMessage({ kind: "event", event });
          });
        }
        es.addEventListener("error", () => {
          if (es.readyState === EventSource.CONNECTING) {
            onRetry?.();
            return;
          }
          if (es.readyState !== EventSource.CLOSED || stopped) return;
          if (ended()) {
            stopped = true;
            stop();
            onMessage({ kind: "done" });
            return;
          }
          onRetry?.();
          const delay = RETRY_DELAYS[Math.min(failures, RETRY_DELAYS.length - 1)];
          failures++;
          timer = setTimeout(open, delay);
        });
      };

      open();
      return () => {
        stopped = true;
        clearTimeout(timer);
        source?.close();
      };
    };
    const stop = whileVisible(connect);
    return stop;
  };
}

function parse(e: Event): unknown {
  try {
    return JSON.parse((e as MessageEvent).data);
  } catch {
    return null;
  }
}

/**
 * One event off the wire, or null for one this viewer cannot read. Frames are the bulk of the
 * stream, up to ten a second, so they are checked by hand rather than through the schema; the rest
 * are rare enough for zod.
 */
export function parseEvent(value: unknown): LiveEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.type === "frame") {
    const f = v.frame as Record<string, unknown> | null | undefined;
    if (
      typeof v.at !== "number" || typeof f !== "object" || f === null ||
      typeof f.data !== "string" || typeof f.width !== "number" || typeof f.height !== "number" ||
      typeof f.tabId !== "string"
    ) {
      return null;
    }
    return { type: "frame", at: v.at, frame: f as LiveFrame };
  }
  const parsed = liveEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
