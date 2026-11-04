// The live uplink for the agent's background commands: one long-lived streamed
// `POST /v1/runs/:id/live/commands` to the historian, NDJSON, so people can watch a command's
// output from the run page as it runs.
// The browser's relay (adapters/browser/relay.ts) is the model; this channel is its own and never
// mixed into that one, since the browser uplink resets its room on every connect.
//
// A new uplink resets the room, so every connection opens with the core's replay — every job's
// `started`, the output it still holds, `exited` for each that ended — and then carries lines as
// they are sent. A line sent while no connection is open is dropped: the next replay has it.
//
// Invariants:
// - best-effort, always: nothing here can fail, gate or slow the run. Every failure is a debug
//   line and a backoff (doubling from a second to thirty), never a throw
// - it ends for exactly three reasons: `close()` (the run is over), the historian saying the run
//   is concluded (410), or the historian refusing the run token (401/403). A 503 is its room
//   cap, and is waited out like any other failure
// - what waits to be sent is bounded: a connection that falls further behind than that is
//   dropped and opened again, and the replay puts the room right
// - the body is pulled, so a replay is encoded only as fast as the historian takes it
// - `close()` lets what is queued go out, bounded, and resolves once the loop is out

import type { Diagnostics } from "../../ports/diagnostics.ts";
import type { CommandLine, CommandsUplink } from "../../ports/background.ts";
import { errorMessage } from "../../helpers/errors.ts";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
/** A connection that lasted this long was a working one: the next failure starts the backoff
 * over. */
const HEALTHY_SESSION_MS = 30_000;
/** What may wait for a slow historian before the connection is given up and opened again. */
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;
/** How long `close()` lets what is queued go out before it cuts the connection. */
const CLOSE_WAIT_MS = 3_000;

export interface CommandsUplinkOptions {
  /** The historian's `POST /v1/runs/:id/live/commands`. */
  url: string;
  /** The run token it authenticates. */
  runToken: string;
  diag: Diagnostics;
  /** Injected by the test. */
  fetch?: typeof fetch;
  backoff?: { baseMs: number; capMs: number };
  healthyMs?: number;
  maxQueuedBytes?: number;
  closeWaitMs?: number;
  now?: () => number;
}

/** The historian's commands uplink for one run, under the history base URL the emitter uses. */
export function commandsSinkUrl(historyUrl: string, runId: string): string {
  return `${historyUrl.replace(/\/+$/, "")}/v1/runs/${encodeURIComponent(runId)}/live/commands`;
}

/** One open connection: what waits to go after the replay, and how to wake its body. */
interface Session {
  queue: Uint8Array[];
  bytes: number;
  wake: (() => void) | null;
  /** No more lines: the body ends once the queue is drained. */
  ending: boolean;
  /** Fell too far behind: the connection is cut. */
  drop: () => void;
}

export function startCommandsUplink(opts: CommandsUplinkOptions): CommandsUplink {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const { baseMs, capMs } = opts.backoff ?? { baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS };
  const healthyMs = opts.healthyMs ?? HEALTHY_SESSION_MS;
  const maxQueued = opts.maxQueuedBytes ?? MAX_QUEUED_BYTES;
  const closeWaitMs = opts.closeWaitMs ?? CLOSE_WAIT_MS;
  const now = opts.now ?? (() => Date.now());
  const encoder = new TextEncoder();
  const encode = (line: CommandLine) => encoder.encode(JSON.stringify(line) + "\n");
  const stopper = new AbortController();
  /** Aborted by `close()`: a backoff between connections ends at once. */
  const closer = new AbortController();
  let loop: Promise<void> | null = null;
  let current: Session | null = null;
  let closing = false;
  let closed: Promise<void> | null = null;

  const session = async (
    replay: () => CommandLine[],
    signal: AbortSignal,
    cut: () => void,
  ): Promise<"retry" | "stop"> => {
    // The replay and the session start in the same tick: a line sent from here on is queued
    // behind it, and none sent before is lost, since the replay already holds it.
    const lines = replay();
    const open: Session = { queue: [], bytes: 0, wake: null, ending: closing, drop: cut };
    current = open;
    const wake = () => open.wake?.();
    signal.addEventListener("abort", wake, { once: true });
    let at = 0;
    const body = new ReadableStream<Uint8Array>({
      // Never throws: a body that errored inside fetch would be a rejection nothing can catch.
      async pull(controller) {
        const end = () => {
          try {
            controller.close();
          } catch {
            // the request is gone already
          }
        };
        try {
          for (;;) {
            if (signal.aborted) return end();
            if (at < lines.length) return controller.enqueue(encode(lines[at++]));
            const next = open.queue.shift();
            if (next !== undefined) {
              open.bytes -= next.byteLength;
              return controller.enqueue(next);
            }
            if (open.ending) return end();
            await new Promise<void>((resolve) => (open.wake = resolve));
            open.wake = null;
          }
        } catch {
          end();
        }
      },
      cancel() {
        open.ending = true;
      },
    });
    // A historian that answers before it has read the body (a 503, a 410) must not leave the
    // connection open with the upload stalled on it. fetch does not pool such a connection: one
    // whose answer came before its streamed body ended is closed (measured on Bun 1.4 and Node 24,
    // tests/background_channels_test.ts), and the session's abort cuts one still in flight.
    try {
      const sink = await doFetch(opts.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.runToken}`,
          "content-type": "application/x-ndjson",
        },
        body,
        signal,
        // A streamed request body, sent chunked as it is pulled.
        duplex: "half",
        // Bun's fetch gives up on a response that has not arrived within its idle timeout (300 s,
        // fired on a coarse tick: about six minutes), and bytes going UP do not reset it. The
        // historian answers this request only once the body ends, so the default would cut every
        // uplink on that period. Its lifetime is the session's: `signal` ends it.
        timeout: false,
      } as RequestInit);
      await sink.body?.cancel().catch(() => {});
      if (sink.status === 410) {
        opts.diag.debug("background.live.concluded", {});
        return "stop";
      }
      if (sink.status === 401 || sink.status === 403) {
        opts.diag.warn("background.live.refused", { status: sink.status });
        return "stop";
      }
      opts.diag.debug("background.live.ended", { status: sink.status });
      return "retry";
    } finally {
      signal.removeEventListener("abort", wake);
      if (current === open) current = null;
      open.ending = true;
      open.wake?.();
    }
  };

  const run = async (replay: () => CommandLine[]) => {
    let failures = 0;
    while (!stopper.signal.aborted && !closing) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      stopper.signal.addEventListener("abort", abort, { once: true });
      const started = now();
      let verdict: "retry" | "stop" = "retry";
      try {
        verdict = await session(replay, controller.signal, abort);
      } catch (err) {
        if (stopper.signal.aborted) break;
        // The historian closed the uplink, the network dropped, or this side fell behind and
        // cut it — all the same here: start over after a pause, with a fresh replay.
        opts.diag.debug("background.live.dropped", { err: errorMessage(err) });
      } finally {
        controller.abort();
        stopper.signal.removeEventListener("abort", abort);
      }
      if (verdict === "stop" || stopper.signal.aborted || closing) break;
      if (now() - started >= healthyMs) failures = 0;
      const delay = Math.min(capMs, baseMs * 2 ** failures);
      failures++;
      await sleep(delay, AbortSignal.any([stopper.signal, closer.signal]));
    }
  };

  return {
    open(replay) {
      if (loop !== null || closing) return;
      loop = run(replay).catch((err) =>
        opts.diag.debug("background.live.loop_failed", { err: errorMessage(err) })
      );
    },
    send(line) {
      const open = current;
      if (open === null || open.ending) return;
      const bytes = encode(line);
      if (open.bytes + bytes.byteLength > maxQueued) {
        opts.diag.debug("background.live.behind", { queued: open.bytes });
        open.ending = true;
        open.drop();
        return;
      }
      open.queue.push(bytes);
      open.bytes += bytes.byteLength;
      open.wake?.();
    },
    close() {
      closed ??= (async () => {
        closing = true;
        closer.abort();
        if (loop === null) return;
        if (current !== null) {
          current.ending = true;
          current.wake?.();
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<void>((resolve) => (timer = setTimeout(resolve, closeWaitMs)));
        await Promise.race([loop, late]);
        clearTimeout(timer);
        stopper.abort();
        await loop;
      })();
      return closed;
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
