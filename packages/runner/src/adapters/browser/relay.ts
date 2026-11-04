// The live relay: what the browser sidecar shows, carried to the historian so a person can watch
// the run's browser from the run page.
//
// One session is two requests joined end to end: `GET /live` on the sidecar (NDJSON, starting
// with a `snapshot` line) is the BODY of a streamed `POST /v1/runs/:id/live` to the historian.
// The runner reads nothing in between and shapes nothing — the lines are the sidecar's, their
// limits the historian's. Either side ending ends the session, and the next one starts both
// afresh: a new `/live` consumer replaces the old one on the sidecar and opens with a fresh
// snapshot, and a new uplink replaces the old one on the historian, so a reconnect never leaves
// the run page on a stale picture.
//
// Invariants:
// - best-effort, always: nothing here can fail, gate or slow the run. Every failure is a debug
//   line and a backoff (doubling from a second to thirty), never a throw
// - it ends for exactly three reasons: `stop()` (the run is over), the historian saying the run
//   is concluded (410, which it means: do not come back), or the historian refusing the run token
//   (401/403 — retrying a credential that was refused is noise). A 503 is its room cap, and is
//   waited out like any other failure
// - a 503 from the SIDECAR is different: it is a sidecar that lost its configuration, which is a
//   sidecar that restarted (an OOM kill, a Chromium crash taking the process). `/configure` is
//   one-shot per process, so the restarted one takes the same token and proxy again; the relay
//   asks for that (`reconfigure`) and resumes at once, with no backoff for the first try
// - `stop()` aborts both requests and resolves once the loop is out, so the composition root can
//   drain it before the process exits
// - the run token rides the historian request only; the sidecar's bearer rides the sidecar's.
//   Neither side ever sees the other's credential

import type { Diagnostics } from "../../ports/diagnostics.ts";
import { errorMessage } from "../../helpers/errors.ts";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
/** A session that lasted this long was a working one: the next failure starts the backoff over. */
const HEALTHY_SESSION_MS = 30_000;

export interface LiveRelayOptions {
  /** The sidecar's `GET /live`, and the bearer the runner configured it with. */
  source: { url: string; token: string };
  /** The historian's `POST /v1/runs/:id/live`, and the run token it authenticates. */
  sink: { url: string; runToken: string };
  diag: Diagnostics;
  /** Injected by the test. */
  fetch?: typeof fetch;
  /**
   * Re-sends the sidecar its configuration after it answered 503 (it restarted and forgot it).
   * True: configured again (or already was, a 409 to this re-send), so the session is retried at once. Absent: a
   * 503 is waited out like any other failure.
   */
  reconfigure?: () => Promise<boolean>;
  backoff?: { baseMs: number; capMs: number };
  healthyMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface LiveRelay {
  /** Ends the relay: aborts whatever session is open and resolves once the loop has exited. */
  stop(): Promise<void>;
}

/** The historian's live uplink for one run, under the history base URL the emitter uses. */
export function liveSinkUrl(historyUrl: string, runId: string): string {
  return `${historyUrl.replace(/\/+$/, "")}/v1/runs/${encodeURIComponent(runId)}/live`;
}

export function startLiveRelay(opts: LiveRelayOptions): LiveRelay {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const { baseMs, capMs } = opts.backoff ?? { baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS };
  const healthyMs = opts.healthyMs ?? HEALTHY_SESSION_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? abortableSleep;
  const stopper = new AbortController();

  /** One session: "stop" when the historian said not to come back, "reconfigured" when the
   * sidecar had restarted and was configured again, "retry" otherwise. */
  const session = async (signal: AbortSignal): Promise<"retry" | "stop" | "reconfigured"> => {
    const source = await doFetch(opts.source.url, {
      headers: { authorization: `Bearer ${opts.source.token}` },
      signal,
      // A quiet browser sends nothing for minutes; Bun's fetch idle timeout would cut it.
      timeout: false,
    } as RequestInit);
    if (!source.ok || source.body === null) {
      await source.body?.cancel().catch(() => {});
      opts.diag.debug("browser.live.source_refused", { status: source.status });
      if (source.status === 503 && opts.reconfigure !== undefined) {
        if (await opts.reconfigure()) return "reconfigured";
      }
      return "retry";
    }
    const sink = await doFetch(opts.sink.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.sink.runToken}`,
        "content-type": "application/x-ndjson",
      },
      body: endingQuietly(source.body, signal),
      signal,
      // A streamed request body, sent chunked as it arrives.
      duplex: "half",
      // Bun's fetch gives up on a response that has not arrived within its idle timeout (300 s,
      // fired on a coarse tick: about six minutes), and bytes going UP do not reset it. The
      // historian answers only once the body ends, so the default cut every session on that
      // period. Its lifetime is the session's: `signal` ends it.
      timeout: false,
    } as RequestInit);
    await sink.body?.cancel().catch(() => {});
    if (sink.status === 410) {
      opts.diag.debug("browser.live.concluded", {});
      return "stop";
    }
    if (sink.status === 401 || sink.status === 403) {
      opts.diag.warn("browser.live.refused", { status: sink.status });
      return "stop";
    }
    // 200 is the sidecar's stream ending (it restarted, or replaced us); anything else is the
    // historian's to explain, and both are worth another try.
    opts.diag.debug("browser.live.ended", { status: sink.status });
    return "retry";
  };

  const loop = (async () => {
    let failures = 0;
    let lastReconfigured = false;
    while (!stopper.signal.aborted) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      stopper.signal.addEventListener("abort", abort, { once: true });
      const started = now();
      let verdict: "retry" | "stop" | "reconfigured" = "retry";
      try {
        verdict = await session(controller.signal);
      } catch (err) {
        if (stopper.signal.aborted) break;
        // The sidecar went away, the historian closed the uplink (it does at conclusion), or the
        // network dropped — all the same to a relay: start over after a pause.
        opts.diag.debug("browser.live.dropped", { err: errorMessage(err) });
      } finally {
        // Whichever side ended first, the other goes with it.
        controller.abort();
        stopper.signal.removeEventListener("abort", abort);
      }
      if (verdict === "stop" || stopper.signal.aborted) break;
      // Straight back after a reconfigure — but only once in a row, so a sidecar that keeps
      // forgetting is backed off from like any other failure.
      const again = verdict === "reconfigured" && !lastReconfigured;
      lastReconfigured = verdict === "reconfigured";
      if (again) continue;
      if (now() - started >= healthyMs) failures = 0;
      const delay = Math.min(capMs, baseMs * 2 ** failures);
      failures++;
      await sleep(delay, stopper.signal);
    }
  })();

  return {
    async stop() {
      stopper.abort();
      await loop;
    },
  };
}

/**
 * The sidecar's stream as a request body that only ever ENDS, never errors. Handed over as is, a
 * source aborted mid-read errors the upload inside fetch, where nothing can catch it: an
 * unhandled rejection, which takes the process down. Here a failed read or the session's abort
 * simply closes the body, and the request's own outcome — awaited above — says what happened.
 */
function endingQuietly(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const release = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", release, { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (!done) return controller.enqueue(value);
      } catch {
        // the sidecar went away, or the session was aborted: the body ends here
      }
      signal.removeEventListener("abort", release);
      controller.close();
    },
    cancel() {
      signal.removeEventListener("abort", release);
      release();
    },
  });
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
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
