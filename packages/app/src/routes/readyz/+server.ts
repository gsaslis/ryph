import type { RequestHandler } from "@sveltejs/kit";

/**
 * Readiness: should this replica receive traffic? For the BFF that is the same question as
 * liveness, and deliberately so — it holds no state and opens no connections of its own.
 *
 * It must NOT probe the control plane. The app's job during a control-plane outage is to render
 * the error, not to disappear: taking every replica out of rotation would replace a degraded UI
 * with no UI at all, and the load balancer would have nowhere left to send anyone.
 */
export const GET: RequestHandler = () =>
  new Response(JSON.stringify({ status: "ok" }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
