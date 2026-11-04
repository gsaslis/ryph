import { z } from "zod";
import { apiCall, ApiError, apiText } from "./call";
import { RETRY_DELAYS } from "./browser-live";
import { whileVisible } from "./visible-stream";

// A run's background commands: what the agent started with `ryph__background_run`, how each one
// ended, and its output. Two sources, read side by side: the control plane's durable record (every
// job and how it ended, and its log once it has one) and the historian's live room (what the jobs
// print, while the run is live).
//
// Everything here is the agent's own words — labels, commands, output — and is only ever shown as
// text.

/** How a job ended. */
export const backgroundReasonSchema = z.enum(["exited", "timeout", "stopped", "run_ended"]);
export type BackgroundReason = z.infer<typeof backgroundReasonSchema>;

/** A moment as the control plane sends it, an ISO string, kept as epoch milliseconds. */
const isoMs = z.iso.datetime({ offset: true }).transform((value) => Date.parse(value));

/** One job as the app holds it, whichever source it came from. Times are epoch milliseconds. */
export interface BackgroundJob {
  /** `bg-<n>`, minted by the runner, unique within the run. */
  id: string;
  label: string;
  command: string;
  cwd: string;
  /** A long-lived process (a dev server): the run does not wait on it. */
  service: boolean;
  startedAt: number;
  timeoutAt: number | null;
  /** Null while it runs. */
  endedAt: number | null;
  reason: BackgroundReason | null;
  exitCode: number | null;
  signal: string | null;
  /** The control plane holds its log. */
  hasLog: boolean;
  /** The last lines of its output, as the durable record kept them; null when it kept none. */
  logTail: string | null;
  logTruncated: boolean;
}

/** A row of `GET /v1/runs/:id/background`; everything about the end is null while it runs. */
const durableJobSchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  cwd: z.string(),
  service: z.boolean(),
  startedAt: isoMs,
  timeoutAt: isoMs.nullable(),
  endedAt: isoMs.nullable(),
  reason: backgroundReasonSchema.nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  hasLog: z.boolean(),
  logTail: z.string().nullable(),
  logTruncated: z.boolean(),
});

/** The list as the route answers it. A row that does not read is left out rather than failing
 * the rest. */
export function parseBackgroundJobs(body: unknown): BackgroundJob[] {
  const { jobs } = z.object({ jobs: z.array(z.unknown()) }).parse(body);
  const out: BackgroundJob[] = [];
  for (const row of jobs) {
    const parsed = durableJobSchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function runPath(runId: string): string {
  return `/v1/runs/${encodeURIComponent(runId)}/background`;
}

function backgroundLogPath(runId: string, jobId: string): string {
  return `${runPath(runId)}/${encodeURIComponent(jobId)}/log`;
}

/** Every background job of a run, without their logs. */
export async function getRunBackground(f = fetch, runId: string): Promise<BackgroundJob[]> {
  return parseBackgroundJobs(await apiCall(f, runPath(runId)));
}

/** A job's stored log, or null when the control plane holds none. */
export async function getBackgroundLog(
  f = fetch,
  runId: string,
  jobId: string,
): Promise<string | null> {
  try {
    return await apiText(f, backgroundLogPath(runId, jobId));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** The raw log, through the proxy, for a new tab. */
export function backgroundLogHref(runId: string, jobId: string): string {
  return `/api${backgroundLogPath(runId, jobId)}`;
}

// ---- The live room ------------------------------------------------------------------------

const startedFields = {
  at: z.number(),
  id: z.string(),
  label: z.string(),
  command: z.string(),
  cwd: z.string(),
  service: z.boolean(),
  timeoutAt: z.number().nullable(),
};

const startedSchema = z.object({ type: z.literal("started"), ...startedFields });
const skippedSchema = z.object({
  type: z.literal("skipped"),
  at: z.number(),
  id: z.string(),
  bytes: z.number().nonnegative(),
});
const exitedSchema = z.object({
  type: z.literal("exited"),
  at: z.number(),
  id: z.string(),
  reason: backgroundReasonSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
});
const outputSchema = z.object({
  type: z.literal("output"),
  at: z.number(),
  id: z.string(),
  text: z.string(),
});

export const commandsEventSchema = z.discriminatedUnion("type", [
  startedSchema,
  outputSchema,
  skippedSchema,
  exitedSchema,
]);
export type CommandsEvent = z.infer<typeof commandsEventSchema>;

/** A job in a snapshot: a running one has no end fields, an ended one has them all. */
const liveJobSchema = z.discriminatedUnion("status", [
  z.object({ ...startedFields, status: z.literal("running"), tail: z.string() }),
  z.object({
    ...startedFields,
    status: z.literal("ended"),
    reason: backgroundReasonSchema,
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    endedAt: z.number(),
    tail: z.string(),
  }),
]);
export type LiveCommandsJob = z.infer<typeof liveJobSchema>;

/** What the stream opens with, and again after every reconnect: the room as it stands. */
const snapshotSchema = z.object({
  at: z.number(),
  /** Whether the runner is relaying right now. */
  uplink: z.boolean(),
  jobs: z.array(z.unknown()),
});
export interface CommandsSnapshot {
  uplink: boolean;
  jobs: LiveCommandsJob[];
}

/** A snapshot off the wire, its unreadable jobs left out; null when it is not one at all. */
export function parseCommandsSnapshot(value: unknown): CommandsSnapshot | null {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) return null;
  const jobs: LiveCommandsJob[] = [];
  for (const job of parsed.data.jobs) {
    const read = liveJobSchema.safeParse(job);
    if (read.success) jobs.push(read.data);
  }
  return { uplink: parsed.data.uplink, jobs };
}

/**
 * One line off the wire, or null for one this viewer cannot read. Output is the bulk of the
 * stream, so it is checked by hand; the rest are rare enough for zod.
 */
export function parseCommandsEvent(value: unknown): CommandsEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.type === "output") {
    if (typeof v.at !== "number" || typeof v.id !== "string" || typeof v.text !== "string") {
      return null;
    }
    return { type: "output", at: v.at, id: v.id, text: v.text };
  }
  const parsed = commandsEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Everything the commands stream can say, in the order it says it. */
export type CommandsMessage =
  | { kind: "snapshot"; snapshot: CommandsSnapshot }
  | { kind: "event"; event: CommandsEvent }
  | { kind: "uplink"; connected: boolean }
  /** A slow viewer lost this many queued lines. */
  | { kind: "dropped"; count: number }
  /** The run concluded; the stream is closed and stays closed. */
  | { kind: "done" };

/** Where a viewer's messages come from; returns the way to stop it. */
export type CommandsSource = (handlers: {
  onMessage(message: CommandsMessage): void;
  /** The stream is open (again). A snapshot follows. */
  onOpen?(): void;
  /**
   * The stream dropped and is being retried. `busy` when the historian turned it away for having
   * too many viewers on the run already.
   */
  onRetry?(busy?: boolean): void;
}) => () => void;

const EVENT_NAMES = ["started", "output", "skipped", "exited"] as const;

/**
 * The run's background commands, live, over SSE through the same-origin proxy with the run's
 * history grant. Retried as the browser's stream is (`liveStreamSource`): EventSource reconnects a
 * dropped stream itself, and an answer that is not a stream (no room yet, a lapsed grant, a
 * restarting historian) is retried here on a backoff, the grant read afresh each time. Every
 * (re)connect starts with a snapshot, and `done` ends it for good.
 */
export function commandsLiveSource(
  runId: string,
  grant: () => string | null,
  ended: () => boolean = () => false,
): CommandsSource {
  const url = () => {
    const g = grant();
    const suffix = g ? `?grant=${encodeURIComponent(g)}` : "";
    return `/api/v1/runs/${encodeURIComponent(runId)}/live/commands/stream${suffix}`;
  };
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
          const snapshot = parseCommandsSnapshot(parse(e));
          if (snapshot === null) return;
          failures = 0;
          onMessage({ kind: "snapshot", snapshot });
        });
        es.addEventListener("uplink", (e) => {
          const body = z.object({ connected: z.boolean() }).safeParse(parse(e));
          if (body.success) onMessage({ kind: "uplink", connected: body.data.connected });
        });
        es.addEventListener("dropped", (e) => {
          const body = z.object({ count: z.number() }).safeParse(parse(e));
          if (body.success) onMessage({ kind: "dropped", count: body.data.count });
        });
        es.addEventListener("done", () => {
          stopped = true;
          stop();
          onMessage({ kind: "done" });
        });
        for (const name of EVENT_NAMES) {
          es.addEventListener(name, (e) => {
            const event = parseCommandsEvent(parse(e));
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
          const delay = RETRY_DELAYS[Math.min(failures, RETRY_DELAYS.length - 1)];
          failures++;
          // EventSource never says why it was refused; one plain request does, and a run with too
          // many viewers already is worth saying so about, rather than reconnecting in silence.
          void refusedForViewers(es.url).then((busy) => {
            if (stopped) return;
            onRetry?.(busy);
            timer = setTimeout(open, delay);
          });
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

/** The status 429 the historian answers a stream it has too many viewers for. */
export const TOO_MANY_VIEWERS = 429;
/** How long the probe waits for an answer before taking it as not busy. */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * Whether the stream at `url` is refused for too many viewers. Asks once and lets go at once: an
 * answer that IS a stream is closed before it says anything.
 */
async function refusedForViewers(url: string): Promise<boolean> {
  const abort = new AbortController();
  try {
    // An answer that never comes is no answer: the stream is retried as it would be anyway.
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
    const res = await fetch(url, { signal, headers: { accept: "text/event-stream" } });
    return res.status === TOO_MANY_VIEWERS;
  } catch {
    return false;
  } finally {
    abort.abort();
  }
}

function parse(e: Event): unknown {
  try {
    return JSON.parse((e as MessageEvent).data);
  } catch {
    return null;
  }
}
