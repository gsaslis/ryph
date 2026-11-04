// `EventSink` over HTTP — a POST per event to whatever holds the webhook mailroom, with a
// shared bearer.
//
// The status mapping is the whole point, and it is the same one @ryph/forge's sink uses: a 2xx
// consumed the event, including every business refusal (those are answered 200 on purpose, so a
// queue never retries a DECISION). Terminal is reserved for the two answers that mean THIS
// PAYLOAD will never be accepted — 400 malformed, 422 unprocessable. Everything else (401/403 a
// misconfigured token, 404 a deploy skew, 429, 5xx, a dead socket) is retryable, because the
// queue holds the only copy and "drop it" must never be the answer to something an operator can
// fix.
//
// The URL is a full endpoint rather than a base plus a path this package invents: what sits at
// the other end is the host's choice, and the bridge has no business knowing its route table.

import type { BridgeEvent, DeliverOutcome, EventSink } from "../../ports/event_sink.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";

export interface HttpEventSinkOptions {
  /** The absolute endpoint events are POSTed to — `RYPH_RADICLE_EVENTS_URL`. */
  url: string;
  /** The shared credential this process presents. */
  token: string;
  diag: Diagnostics;
  requestTimeoutMs?: number;
}

/**
 * Short on purpose. Deliveries are SEQUENTIAL and a held one holds its reference's cursor, so
 * the sink's timeout is the unit a stalled mailroom costs a reconcile pass — measured on
 * a live cluster, a NetworkPolicy that dropped the bridge's POSTs turned a 30s timeout into a pass
 * that took minutes and never finished. Five seconds is far above a healthy round trip to a
 * pod in the same cluster, and the consumer retries on its own cadence anyway.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

export function httpEventSink(opts: HttpEventSinkOptions): EventSink {
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async deliver(event: BridgeEvent): Promise<DeliverOutcome> {
      try {
        const res = await fetch(opts.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          await res.body?.cancel();
          return { kind: "ok" };
        }
        const body = await res.json().catch(() => null) as { error?: unknown } | null;
        const message = typeof body?.error === "string"
          ? body.error
          : `the event sink answered ${res.status}`;
        return { kind: "failed", message, terminal: res.status === 400 || res.status === 422 };
      } catch (err) {
        opts.diag.warn("event_sink.unreachable", { err: String(err) });
        return {
          kind: "failed",
          message: `the event sink is unreachable: ${err}`,
          terminal: false,
        };
      }
    },
  };
}
