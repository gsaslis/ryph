// `EventSink` over HTTP: POST the fire to the orchestrator's events door with the shared
// service token. The terminality mapping is the forge sink's, verbatim: 400/422 mean "this
// event can never be accepted" (a schema the other side refuses), everything else — 5xx, a
// dead socket, a timeout — is a moment to retry through.

import type { AutomationEvent } from "../../core/types.ts";
import type { AccessProbe, DeliverResult, EventSink } from "../../ports/event_sink.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";

export interface HttpEventSinkOptions {
  orchestratorUrl: string;
  automationsToken: string;
  diag: Diagnostics;
  requestTimeoutMs?: number;
}

export function httpEventSink(opts: HttpEventSinkOptions): EventSink {
  const base = opts.orchestratorUrl.replace(/\/+$/, "");
  // Room for the door's slowest honest answer: on a hanging forge it waits out the access check
  // and the services.yml read (60 s) before it can fall back to what is cached. Cut shorter, the
  // fire is retried while the first attempt is still starting the run.
  const timeoutMs = opts.requestTimeoutMs ?? 90_000;

  return {
    async deliver(event: AutomationEvent): Promise<DeliverResult> {
      try {
        const res = await fetch(`${base}/v1/automations/events`, {
          method: "POST",
          headers: {
            "authorization": `Bearer ${opts.automationsToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = (await res.json().catch(() => null)) ?? {};
        if (res.ok) {
          return {
            kind: "ok",
            outcome: typeof body.outcome === "string" ? body.outcome : "started",
            taskId: typeof body.taskId === "string" ? body.taskId : null,
            runId: typeof body.runId === "string" ? body.runId : null,
            detail: typeof body.detail === "string" ? body.detail : null,
          };
        }
        return {
          kind: "failed",
          message: typeof body.error === "string" ? body.error : `status ${res.status}`,
          terminal: res.status === 400 || res.status === 422,
        };
      } catch (err) {
        opts.diag.warn("event_sink.unreachable", { err: String(err) });
        return { kind: "failed", message: String(err), terminal: false };
      }
    },

    async refreshAccess(probe: AccessProbe): Promise<void> {
      try {
        const res = await fetch(`${base}/v1/automations/access`, {
          method: "POST",
          headers: {
            "authorization": `Bearer ${opts.automationsToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(probe),
          signal: AbortSignal.timeout(timeoutMs),
        });
        await res.body?.cancel();
        if (!res.ok) opts.diag.warn("event_sink.access_refresh_failed", { status: res.status });
      } catch (err) {
        opts.diag.warn("event_sink.access_refresh_failed", { err: String(err) });
      }
    },
  };
}
