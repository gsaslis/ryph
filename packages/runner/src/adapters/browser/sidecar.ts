// The browser sidecar, brought up from the runner's side.
//
// The platform launched it beside this run — a native sidecar on Kubernetes, which is up before
// the runner starts, or a container in the runner's network namespace under docker, which starts
// a moment after it — and it listens on loopback, answering nothing useful until it is told who
// may drive it. This adapter is that telling, and everything after it:
//
//   1. wait for its port (a minute at most, from boot, overlapping the clone and setup);
//   2. `POST /configure` (again after a restart, below), with the bearer the runner minted for it
//      and the run's egress proxy credentials, so Chromium leaves the box the way the agent's
//      shell does — through the proxy, under the same allowlist, with loopback and the run's
//      services direct (never the platform's hosts: a page's JavaScript is untrusted, and the
//      proxy refuses them) — and `vision`, whether the run's model can see a screenshot;
//   3. answer `ready` with its tool server, which the harness dials like the runner's own;
//   4. relay its live stream to the historian until the run ends (adapters/browser/relay.ts).
//
// The sidecar holds the browser's bearer and the egress pair and nothing else: never the run
// token, never a platform address. Whatever reaches the historian is sent from here.
//
// A sidecar that RESTARTS (an OOM kill, say — on Kubernetes it is a restartable init container,
// on docker it is not restarted at all) comes back unconfigured, answering 503. The relay is what
// notices, and it re-sends the same `/configure` — one-shot per process, so the new process takes
// it — and resumes. A 409 there means the shot was already spent, by this runner's own call
// landing on a sidecar that came back quicker than the relay noticed: carry on. A 409 on the
// FIRST configure is different: nothing of this runner's has reached the sidecar yet, so another
// process won the race to configure it, and holds its bearer. That browser is not this run's.
//
// Invariants:
// - nothing in THIS adapter is fatal. A port that never opens, a configure that is refused, a
//   relay that cannot reach the historian — each is a run without a browser (or without a live
//   view), told so, never a failed run, and never a run held past the one-minute wait. What can
//   stop a run is upstream of it: an unpullable browser image holds a Kubernetes pod in `Init:`
//   before the runner ever starts (a misconfigured deployment, accepted — see the orchestrator's
//   kubernetes provisioner)
// - `ready` never rejects, and settles at once when the run is cancelled
// - `stop()` ends the wait and the relay and resolves once both are done; the composition root
//   calls it at run end, before the process exits

import type { BrowserSession, BrowserState } from "../../ports/browser.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import { errorMessage } from "../../helpers/errors.ts";
import { tcpProbe } from "../../helpers/services.ts";
import { type LiveRelay, type LiveRelayOptions, liveSinkUrl, startLiveRelay } from "./relay.ts";

/** The slug the harness registers the browser's tool server under — `browser__navigate`. */
export const BROWSER_SERVER_SLUG = "browser";

/**
 * How long the browser gets to answer, counted from boot. Docker starts it after the runner's
 * container, and Chromium's image is not small; on Kubernetes it starts before the runner but
 * nothing waits on it there either. A minute, and then the run goes on without it.
 */
export const BROWSER_WAIT_MS = 60_000;
const PROBE_INTERVAL_MS = 250;
/** The configure call's own budget: the sidecar answers it from memory. */
const CONFIGURE_TIMEOUT_MS = 10_000;

/** The `proxy` field of `/configure`: Playwright's own shape, the bypass comma-separated. */
export interface BrowserProxyConfig {
  server: string;
  username: string;
  password: string;
  bypass: string;
}

export interface BrowserSidecarOptions {
  /** The loopback port the work item names. */
  port: number;
  /** Where the sidecar answers; loopback in every deployment that launches one. */
  host?: string;
  /** The bearer the runner minted for it — the same value parked under `tokenEnv`. */
  token: string;
  /** The runner env var holding `token`, for the harness to hand on at spawn. */
  tokenEnv: string;
  /** The run's way out (helpers/environment.ts `browserEgressProxy`); null: the run has none, and
   * neither does its browser. */
  proxy: BrowserProxyConfig | null;
  /** Whether the run's model can see images (`/configure`'s `vision`). False: the sidecar lists
   * no screenshot tool, since its pictures would reach a model that cannot look at them.
   * Defaults to true. */
  vision?: boolean;
  /** Where the live stream goes; null for a run with no historian to show it (a CLI run). */
  live: { historyUrl: string; runToken: string; runId: string } | null;
  /** The run's cancel: settles a pending wait as failed. */
  signal: AbortSignal;
  diag: Diagnostics;
  /** The runner's operational log, for the lines an operator reads at the default level: the
   * browser coming up, and coming back after a restart. Absent: those go to `diag` alone. */
  log?: { info(message: string, fields?: Record<string, unknown>): void };
  /** Injected by the tests. */
  waitMs?: number;
  probeIntervalMs?: number;
  probe?: (target: { name: string; port: number }, signal: AbortSignal) => Promise<boolean>;
  fetch?: typeof fetch;
  relay?: Pick<LiveRelayOptions, "backoff" | "healthyMs">;
}

export interface BrowserSidecar extends BrowserSession {
  /** Ends the wait (if still waiting) and the relay; resolves once both are done. Idempotent. */
  stop(): Promise<void>;
}

export function startBrowserSidecar(opts: BrowserSidecarOptions): BrowserSidecar {
  const host = opts.host ?? "127.0.0.1";
  const base = `http://${host.includes(":") ? `[${host}]` : host}:${opts.port}`;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const probe = opts.probe ?? tcpProbe;
  const waitMs = opts.waitMs ?? BROWSER_WAIT_MS;
  const interval = opts.probeIntervalMs ?? PROBE_INTERVAL_MS;
  const stopper = new AbortController();
  const signal = AbortSignal.any([opts.signal, stopper.signal]);
  let relay: LiveRelay | null = null;

  /** An operator-facing line: info on the log, and the same event in the run's diagnostics. */
  const info = (event: string, fields: Record<string, unknown>) => {
    opts.diag.debug(event, fields);
    try {
      opts.log?.info(event, fields);
    } catch {
      // a log line can neither throw nor block the bring-up
    }
  };

  const failed = (reason: string): BrowserState => {
    opts.diag.warn("browser.failed", { port: opts.port, reason });
    return { kind: "failed", reason };
  };

  /**
   * `POST /configure` with this run's token and proxy — the same body every time, so a sidecar
   * that restarted and forgot it is told exactly what it was told before. "configured" on a 2xx,
   * and, `again`, on a 409 too: the shot was already spent, which for a sidecar this runner
   * configured once means a retry of a call that landed. On the first configure a 409 is someone
   * else's shot (see the note at the top). Otherwise the status, for the reason.
   */
  const configure = async (again: boolean): Promise<"configured" | number> => {
    const res = await doFetch(`${base}/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: opts.token, proxy: opts.proxy, vision: opts.vision ?? true }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(CONFIGURE_TIMEOUT_MS)]),
    });
    await res.body?.cancel().catch(() => {});
    return res.ok || (again && res.status === 409) ? "configured" : res.status;
  };

  const ready = (async (): Promise<BrowserState> => {
    try {
      const deadline = Date.now() + waitMs;
      let up = false;
      while (!signal.aborted && Date.now() < deadline) {
        if (await probe({ name: host, port: opts.port }, signal)) {
          up = true;
          break;
        }
        await pause(interval, signal);
      }
      if (!up) {
        return failed(
          signal.aborted
            ? "the run ended before the browser answered"
            : `the browser did not answer on ${host}:${opts.port} within ${
              Math.round(waitMs / 1000)
            } s`,
        );
      }
      const status = await configure(false);
      if (status === 409) {
        opts.diag.warn("browser.configure_conflict", {
          port: opts.port,
          detail: "the sidecar was already configured, and not by this runner",
        });
        return failed(
          "the browser was already configured by another process (HTTP 409), so it is not this " +
            "run's to drive",
        );
      }
      if (status !== "configured") {
        return failed(`the browser refused its configuration (HTTP ${status})`);
      }
      if (opts.live !== null && !stopper.signal.aborted) {
        relay = startLiveRelay({
          source: { url: `${base}/live`, token: opts.token },
          sink: {
            url: liveSinkUrl(opts.live.historyUrl, opts.live.runId),
            runToken: opts.live.runToken,
          },
          // A sidecar that restarted (503 on /live) is told its configuration again.
          reconfigure: async () => {
            try {
              const again = await configure(true);
              info("browser.reconfigured", { port: opts.port, status: again });
              return again === "configured";
            } catch (err) {
              opts.diag.debug("browser.reconfigure_failed", { err: errorMessage(err) });
              return false;
            }
          },
          diag: opts.diag,
          fetch: doFetch,
          ...opts.relay,
        });
      }
      info("browser.ready", {
        port: opts.port,
        proxied: opts.proxy !== null,
        live: relay !== null,
      });
      return { kind: "ready", tools: { url: `${base}/mcp`, tokenEnv: opts.tokenEnv } };
    } catch (err) {
      return failed(
        signal.aborted ? "the run ended before the browser answered" : errorMessage(err),
      );
    }
  })();

  let stopping: Promise<void> | null = null;
  return {
    ready,
    stop() {
      stopping ??= (async () => {
        stopper.abort();
        await ready;
        await relay?.stop();
      })();
      return stopping;
    },
  };
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
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
