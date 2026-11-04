// A long-lived response held open on an API token's bearer must not outlive the bearer. A
// stream's gate checks the token once, when the stream opens; without this, an exchange of an
// API token revoked a minute later would keep an event stream flowing for as long as the
// connection lasts. So a token's stream ends when its `exp` passes, and the client (`ryph mcp`
// asks again) comes back with a fresh one, which the gate checks afresh.
//
// Only a token's (`via: "token"`). A browser session's stream is left alone: its EventSource
// reconnects with whatever cookie and run grant it opened with, which by then are as expired as
// the bearer, so a cut there would turn into a refusal the page never recovers from. A session
// is ended where it is revoked, at auth, as before.

/** setTimeout's ceiling: a longer delay fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * When the request's bearer JWT expires, in epoch ms, if it is an API token's (`via: "token"`);
 * null for anything else (a session's bearer, no bearer, an opaque token, auth off). The token
 * is NOT verified here: call this only after the route's own gate verified the same
 * `authorization` header, which is what makes its claims trustworthy.
 *
 * @example
 * const expiresAt = tokenBearerExpiresAt(req); // 1767225600000
 */
export function tokenBearerExpiresAt(req: Request): number | null {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const parts = header.slice("Bearer ".length).split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(
      Math.ceil(parts[1].length / 4) * 4,
      "=",
    );
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const { exp, via } = JSON.parse(new TextDecoder().decode(bytes)) as {
      exp?: unknown;
      via?: unknown;
    };
    if (via !== "token") return null;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * The same response, its body ended cleanly when the request's API-token bearer expires: the
 * underlying stream is cancelled (so its own `cancel` cleanup runs) and the client sees an
 * ordinary close. A response without a body, or a request without an API token's JWT bearer (a
 * session's included), passes through untouched. Call it only once the route's gate verified
 * the request's bearer.
 *
 * @example
 * return endAtBearerExpiry(req, new Response(body, { headers: { "content-type": "text/event-stream" } }));
 */
export function endAtBearerExpiry(
  req: Request,
  res: Response,
  now: () => number = Date.now,
): Response {
  const expiresAt = tokenBearerExpiresAt(req);
  if (expiresAt === null || res.body === null) return res;
  const reader = res.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const end = () => {
        if (ended) return;
        ended = true;
        void reader.cancel("the bearer expired").catch(() => {});
        try {
          controller.close();
        } catch {
          // Already closed or errored.
        }
      };
      timer = setTimeout(end, Math.min(Math.max(expiresAt - now(), 0), MAX_TIMER_MS));
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (ended) return;
        if (done) {
          ended = true;
          clearTimeout(timer);
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        controller.error(err);
      }
    },
    cancel(reason) {
      ended = true;
      clearTimeout(timer);
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
