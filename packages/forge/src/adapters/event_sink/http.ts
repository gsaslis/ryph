// `EventSink` over HTTP to the orchestrator's forge intake — the same trust domain (and the
// same shared token) as the key-resolution calls in the other direction.
//
// The status mapping is the whole point: a 2xx consumed the event (including "seen it
// before" and every business refusal — the orchestrator answers those 200 on purpose, so the
// webhook queue never retries a decision). Terminal is reserved for the two answers that mean
// THIS PAYLOAD will never be accepted (400 malformed, 422 unprocessable); everything else —
// 401/403 (a misconfigured service token an operator will fix), 404 (a version skew a deploy
// will fix), 429, 5xx, network death — is retryable, because the hook queue holds the only
// copy of the event and "drop it" must never be the answer to a recoverable condition. The
// queue's own attempt budget bounds a wrong guess either way.

import type { ForgeEvent } from "../../core/types.ts";
import type { DeliverOutcome, EventSink, GitlabHookGate } from "../../ports/event_sink.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";

export interface HttpEventSinkOptions {
  orchestratorUrl: string;
  forgeToken: string;
  diag: Diagnostics;
  requestTimeoutMs?: number;
}

/**
 * The OUTER deadline of the whole command path: everything the orchestrator's handler does
 * with a delivery — the permission check, and now reading the thread back out of this very
 * service — happens inside it. 15s was sized for a handler that only made a decision; a
 * handler that also reads a long PR needs the room, and the failure it prevents is the
 * nastiest kind, where every delivery times out and every retry times out identically.
 */
const EVENT_SINK_TIMEOUT_MS = 60_000;

export function httpEventSink(opts: HttpEventSinkOptions): EventSink {
  const base = opts.orchestratorUrl.replace(/\/+$/, "");
  const timeoutMs = opts.requestTimeoutMs ?? EVENT_SINK_TIMEOUT_MS;

  return {
    async deliver(event: ForgeEvent): Promise<DeliverOutcome> {
      try {
        const res = await fetch(`${base}/v1/forge/events`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.forgeToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = (await res.json().catch(() => null)) ?? {};
        if (res.ok) return { kind: "ok" };
        const message = typeof body.error === "string"
          ? body.error
          : `orchestrator answered ${res.status}`;
        return { kind: "failed", message, terminal: res.status === 400 || res.status === 422 };
      } catch (err) {
        opts.diag.warn("event_sink.unreachable", { err: String(err) });
        return { kind: "failed", message: `orchestrator unreachable: ${err}`, terminal: false };
      }
    },
  };
}

/**
 * `GitlabHookGate` over the same intake: `POST /v1/forge/gitlab/hooks/admit`. Anything but a
 * 200 naming one of the three answers throws, which the consumer retries — the control plane is
 * the only one who knows whether a token was rotated, and "admit it anyway" is not an answer.
 * Drops over budget are reported to `POST /v1/forge/gitlab/hooks/dropped`.
 */
export function httpGitlabHookGate(opts: HttpEventSinkOptions): GitlabHookGate {
  const base = opts.orchestratorUrl.replace(/\/+$/, "");
  return {
    async admit(projectId, generation, heard) {
      const res = await fetch(`${base}/v1/forge/gitlab/hooks/admit`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.forgeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ projectId, generation, heard }),
        signal: AbortSignal.timeout(opts.requestTimeoutMs ?? 15_000),
      });
      const body = (await res.json().catch(() => null)) ?? {};
      const admission = body.admission;
      if (res.status === 200 && (admission === "stale" || admission === "unconnected")) {
        return { admission };
      }
      if (
        res.status === 200 && admission === "current" && typeof body.connectedAt === "string" &&
        !Number.isNaN(Date.parse(body.connectedAt))
      ) {
        return { admission, connectedAt: body.connectedAt };
      }
      throw new Error(`the orchestrator answered ${res.status} to a hook admission`);
    },
    async dropped(projectId, generation, lane, count) {
      const res = await fetch(`${base}/v1/forge/gitlab/hooks/dropped`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.forgeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ projectId, generation, lane, count }),
        signal: AbortSignal.timeout(opts.requestTimeoutMs ?? 15_000),
      });
      await res.body?.cancel();
      if (res.status !== 200) {
        throw new Error(`the orchestrator answered ${res.status} to a drop report`);
      }
    },
  };
}
