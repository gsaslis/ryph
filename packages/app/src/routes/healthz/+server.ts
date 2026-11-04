import type { RequestHandler } from "@sveltejs/kit";

/**
 * Liveness: is this process alive? No dependencies, no I/O, always 200 — the same contract every
 * other service here answers through @ryph/service, which the app does not import (it builds
 * on Node, through Vite). A 503 here would mean RESTART ME, and the app has nothing
 * it could learn that would justify that.
 */
export const GET: RequestHandler = () =>
  new Response(JSON.stringify({ status: "ok" }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
