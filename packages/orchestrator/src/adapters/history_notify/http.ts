// The conclude signal to a standalone historian: the `concludeRun` closure `concludeOnTerminal`
// calls when a run persists a terminal state, in its remote form. In the single-process host the
// same closure is the historian's in-process `concludeRun`; here it POSTs to the historian's
// internal conclude route, service-authed with the shared RYPH_HISTORY_TOKEN.
//
// Fire-and-forget by contract (`concludeRun` returns void): a terminal save must not wait on, or
// fail for, the historian. But not send-once: the ping is the ONLY way the standalone historian
// learns a run is terminal (it owns no run rows, and the one orchestrator read it makes, the
// run-token verify, needs the run's token and answers every miss with the same 404 by design), so
// a lost ping leaves that run's open tails and live viewers on keepalives with no `done`. A ping
// that fails for a reason that can pass — unreachable, a timeout, a 5xx, a 429 — is retried with
// backoff (1 s doubling to 30 s, 6 retries: a minute or two), on timers that never hold the
// process open. A 4xx is definitive (our service token refused: a misconfiguration no retry
// fixes), logged and dropped. The historian's conclude is idempotent, so a retry of a ping that
// landed unseen is harmless.

import type { Diagnostics } from "../../ports/diagnostics.ts";

export interface HttpConcludeNotifierOptions {
  /** The historian's base URL, as this process dials it; a trailing slash is tolerated. */
  historyUrl: string;
  /** The shared service credential this process presents. */
  historyToken: string;
  diag: Diagnostics;
  /** Per-request deadline. Default 5s. */
  requestTimeoutMs?: number;
  /** Retries after the first attempt, and the backoff between them; the tests shorten both. */
  retries?: number;
  backoff?: { baseMs: number; capMs: number };
}

const DEFAULT_RETRIES = 6;
const DEFAULT_BACKOFF = { baseMs: 1_000, capMs: 30_000 };

export function httpConcludeNotifier(opts: HttpConcludeNotifierOptions): (runId: string) => void {
  const base = opts.historyUrl.replace(/\/+$/, "");
  const timeoutMs = opts.requestTimeoutMs ?? 5_000;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;

  /** True when sent (or definitively refused); false when worth another try. */
  const attempt = async (runId: string, url: string, last: boolean): Promise<boolean> => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.historyToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.body?.cancel().catch(() => {});
      if (res.ok) return true;
      const transient = res.status >= 500 || res.status === 429;
      if (!transient || last) {
        opts.diag.warn("history.conclude_failed", { runId, status: res.status });
        return true;
      }
      opts.diag.debug("history.conclude_retry", { runId, status: res.status });
      return false;
    } catch (err) {
      if (last) {
        opts.diag.warn("history.conclude_unreachable", { runId, err: String(err) });
        return true;
      }
      opts.diag.debug("history.conclude_retry", { runId, err: String(err) });
      return false;
    }
  };

  return (runId: string) => {
    const url = `${base}/internal/v1/runs/${encodeURIComponent(runId)}/conclude`;
    const run = async (n: number): Promise<void> => {
      if (await attempt(runId, url, n >= retries)) return;
      const delay = Math.min(backoff.capMs, backoff.baseMs * 2 ** n);
      const timer = setTimeout(() => void run(n + 1), delay);
      timer.unref();
    };
    void run(0).catch(() => {});
  };
}
