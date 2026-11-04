// The mailroom's say in its host's liveness probe. `/healthz` answers "restart me" with a 503, so
// it says so only for what a restart mends and nothing else will: ticks that keep wedging after
// the mailroom abandoned them (`WebhooksSetup.stalled`). Abandoning a wedged tick is the remedy,
// in every deployment mode; this is the last resort, where something answers the probe. Every
// call a tick makes is bounded, so a database outage ends ticks with warnings instead — and never
// restarts a replica into it.
//
// Mounted AHEAD of the host's own `/healthz`, which it stands in for: when the mailroom is fine,
// it answers exactly that probe's 200.

import { json, type Route, route } from "@ryph/shared/http";

export function livenessRoutes(
  webhooks: { stalled(): string | null },
  log: { warn(event: string, fields?: Record<string, unknown>): void },
): Route[] {
  return [
    route("GET", "/healthz", () => {
      const reason = webhooks.stalled();
      if (reason === null) return json(200, { status: "ok" });
      // The reason goes to the log, never the unauthenticated response.
      log.warn("webhooks.stalled", { reason });
      return json(503, { status: "stalled" });
    }),
  ];
}
