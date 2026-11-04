// The runner's inbound HTTP API — the one surface the outside can call INTO.
//
// Every route is authenticated with the per-run bearer the orchestrator injects: a run
// answers only to its own control plane. This is a driving adapter — the outside drives it — so it
// lives in the outer layer, wired by main.ts, and reaches the core only through its port.
//
// Invariants:
// - a request can never crash the runner: the handler answers every route, and the port call is
//   made defensively — a misbehaving implementation is warned, never propagated
// - an unauthenticated request changes nothing and learns nothing; the token is compared as a
//   digest, in constant time (@ryph/sealed's service gate)
// - starting this server IS the signal that a control token exists; with no token there is no
//   inbound surface at all (see main.ts)

import { makeServiceGate } from "@ryph/sealed";
import { serve } from "@ryph/service";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import type { RunControl } from "../../ports/run_control.ts";

export interface ControlApi {
  /** The bound origin, e.g. "http://0.0.0.0:8080". */
  readonly url: string;
  /** Stops listening and resolves once in-flight requests drain. Driven once by main's disposer. */
  shutdown(): Promise<void>;
}

export interface ControlApiOptions {
  /** The per-run bearer every route requires. */
  token: string;
  /** Port to bind; 0 lets the OS pick a free one (used by tests). */
  port: number;
  /**
   * Interface to bind. Defaults to 0.0.0.0 so a control plane on the shared container network can
   * reach it — 127.0.0.1 would be invisible from outside the container.
   */
  hostname?: string;
  diag: Diagnostics;
}

/**
 * Starts the inbound control API driving the given `RunControl`, and returns a handle to stop it.
 * Binds synchronously, so the returned `url` is live the moment this returns.
 */
export async function startControlApi(
  control: RunControl,
  opts: ControlApiOptions,
): Promise<ControlApi> {
  const authenticate = makeServiceGate(opts.token);
  const handler = async (req: Request): Promise<Response> => {
    // Authenticate first, before any routing: an unauthenticated caller must get 401 for every
    // shape, never a 404/405 that would reveal which routes and methods exist.
    const refused = await authenticate(req);
    if (refused) return refused;

    const { pathname } = new URL(req.url);
    if (pathname !== "/cancel") return new Response("not found\n", { status: 404 });
    if (req.method !== "POST") return new Response("method not allowed\n", { status: 405 });

    // Drive the port. Defensive catch — a request must never take the runner down, even if the
    // implementation behind the port misbehaves.
    try {
      control.requestCancel();
    } catch (err) {
      opts.diag.warn("control.cancel.failed", { err });
    }
    opts.diag.debug("control.cancel.accepted", {});
    return new Response(null, { status: 202 });
  };

  const server = await serve({
    port: opts.port,
    hostname: opts.hostname ?? "0.0.0.0",
    // Keep stdout clean (Result JSON only): the listen notice goes to the machinery log on stderr.
    onListen: (addr) =>
      opts.diag.debug("control.listening", { hostname: addr.hostname, port: addr.port }),
  }, handler);

  const addr = server.addr;
  return {
    url: `http://${addr.hostname}:${addr.port}`,
    shutdown: () => server.shutdown(),
  };
}
