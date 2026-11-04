// Liveness and readiness, as a mountable route list.
//
// The two answer genuinely different questions, and conflating them is the classic way to make a
// rollout worse than no probes at all:
// - `/healthz` — "is this process alive?" No dependencies, no I/O, always 200. A 503 here means
//   RESTART ME, so a database outage must never produce one: restarting every replica against a
//   down database turns a recoverable incident into a crash loop.
// - `/readyz` — "should this replica receive traffic?" Checks the one dependency it cannot serve
//   without, and answers 503 the instant a drain begins, so the load balancer stops sending work
//   before the listener closes. A 503 here means ROUTE AROUND ME, which is cheap and reversible.
//
// Both are UNAUTHENTICATED, because a load balancer carries no bearer — so neither says anything
// a prober should not know. A failed readiness check answers a bare `unready` and puts the reason
// in the log, where it is already behind whatever guards the logs.

import { json } from "@ryph/shared/http";

/** Structurally the `Route` every service in this workspace routes with. */
export interface HealthRoute {
  method: string;
  pattern: URLPattern;
  handler: (req: Request, params: Record<string, string>) => Promise<Response>;
}

export interface HealthDeps {
  /**
   * The one dependency this replica cannot serve without — normally the cheapest possible store
   * read. Returning resolves ready; throwing (or exceeding `timeoutMs`) is unready. Omit it for a
   * service with no such dependency: readiness is then liveness plus the drain flag.
   */
  ready?: () => Promise<unknown>;
  /** Bounds the check, so a hung dependency answers 503 instead of holding the prober open. */
  timeoutMs?: number;
  /** Where a failed check's reason goes — deliberately not into the response. */
  log?: { warn(event: string, fields?: Record<string, unknown>): void };
}

export interface Health {
  /** `GET /healthz` and `GET /readyz`, to spread into the service's route table. */
  routes: HealthRoute[];
  /** Flips readiness off for good. `installDrain` calls this the instant a signal lands. */
  beginDrain(): void;
  /** True once `beginDrain` has been called. */
  readonly draining: boolean;
}

const DEFAULT_TIMEOUT_MS = 2_000;
/** A probe's answer is about this instant only. */
const NO_STORE = { "cache-control": "no-store" };

export function makeHealth(deps: HealthDeps = {}): Health {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let draining = false;

  const check = async (): Promise<string | null> => {
    if (deps.ready === undefined) return null;
    // A dependency that hangs is as unready as one that throws, and much likelier to be the
    // thing actually wrong — so the timer is part of the check, not a nicety around it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([deps.ready(), deadline]);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
  };

  const route = (
    pathname: string,
    handler: HealthRoute["handler"],
  ): HealthRoute => ({
    method: "GET",
    pattern: new URLPattern({ pathname }),
    handler,
  });

  return {
    get draining() {
      return draining;
    },
    beginDrain() {
      draining = true;
    },
    routes: [
      // Alive is alive, draining or not: a process finishing its in-flight work is exactly what
      // should NOT be killed and restarted.
      route("/healthz", () => Promise.resolve(json(200, { status: "ok" }, NO_STORE))),
      route("/readyz", async () => {
        if (draining) return json(503, { status: "draining" }, NO_STORE);
        const reason = await check();
        if (reason === null) return json(200, { status: "ok" }, NO_STORE);
        deps.log?.warn("health.unready", { reason });
        return json(503, { status: "unready" }, NO_STORE);
      }),
    ],
  };
}
