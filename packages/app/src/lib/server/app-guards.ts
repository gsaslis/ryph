/** An artifact version's document, which only ever loads inside its guarded frame. */
export const ARTIFACT_CONTENT_PATH = /^\/artifacts\/[^/]+\/v\/[^/]+\/content\/?$/;
/** Screenshot requests share the content route's non-refreshing session handling, not its CSP. */
export const ARTIFACT_THUMBNAIL_PATH = /^\/artifacts\/[^/]+\/v\/[^/]+\/thumbnail\/?$/;

/**
 * The policy every app page and response carries. No other site may frame this app, and no frame
 * in it may show another site: an artifact's frame sent anywhere else gets an error page instead,
 * which its guard sees load.
 */
export const APP_CSP = "frame-ancestors 'self'; frame-src 'self'";

/**
 * What every response but an artifact's content carries: `APP_CSP`, and no window this app opens
 * (or that opens it) keeps a handle on it. The policy is added next to any the response already
 * has (a proxied image keeps its own), and a browser enforces both. The content route sets its own
 * policy, which is the artifact's.
 */
export function withAppGuards(path: string, response: Response): Response {
  if (ARTIFACT_CONTENT_PATH.test(path)) return response;
  try {
    guard(response.headers);
    return response;
  } catch {
    // A response whose headers are immutable (one passed on from a fetch) gets a copy.
    const headers = new Headers(response.headers);
    guard(headers);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

function guard(headers: Headers): void {
  headers.append("content-security-policy", APP_CSP);
  headers.set("cross-origin-opener-policy", "same-origin");
}
