import { isJsonContentType } from "@ryph/shared/http";
import { ATTACHMENT_MIMES } from "$lib/api/attachments";

/**
 * The guard on every request that changes something, in front of every route: the `/api` proxy,
 * the `/auth` endpoints that set the session cookies, and the form actions.
 *
 * The session cookies are SameSite=Lax, which keeps them off a POST from another SITE but not off
 * one from another ORIGIN on the same site: a sibling subdomain, or on the local binary any other
 * port on localhost (cookies are not port-scoped). SvelteKit's own CSRF check only looks at the
 * form content types, so a `fetch(…, { mode: "no-cors", credentials: "include" })` with a Blob
 * body (no type at all) or a string (`text/plain`) walked straight past it and through the proxy
 * with the person's session. Two rules close that:
 *
 * - the request must prove it comes from this app's own origin: its `Origin` header equals it,
 *   or, with no `Origin`, `Sec-Fetch-Site` says `same-origin`. A browser sends `Origin` on every
 *   request that is not a GET or HEAD, and a page can forge neither. A request with neither is
 *   not a browser's; it is refused when it carries a cookie, and otherwise has no session to
 *   ride on.
 * - a body sent to an endpoint (the proxy and `/auth`) must be `application/json`, which no page
 *   can send to another origin without a preflight this app never answers. That also keeps a
 *   sign-in from being sent for someone (logging them in as the sender), which carries no cookie
 *   yet. A run's image upload is the one exception, in the image types it accepts. Form actions
 *   take the form types, and SvelteKit holds those to the origin too.
 *
 * The `ryph` CLI and `ryph mcp` send no `Origin` and no cookie: their token exchange is JSON, and
 * every later call carries an `Authorization` header, which skips both rules (a check bundle is
 * not JSON). What a bearer reaches through the proxy is already limited to the bearer doors, and a
 * browser never attaches an `Authorization` header to a request another site makes it send.
 *
 * Returns why the request is refused, or null.
 */
export function crossOriginWriteRefusal(
  request: Request,
  url: URL,
  routeId: string | null,
): string | null {
  if (SAFE_METHODS.has(request.method)) return null;
  const headers = request.headers;
  if (headers.has("authorization") && !headers.has("cookie")) return null;

  const origin = headers.get("origin");
  if (origin !== null) {
    if (origin !== url.origin) return "cross-origin request refused";
  } else if (headers.has("sec-fetch-site")) {
    if (headers.get("sec-fetch-site") !== "same-origin") return "cross-origin request refused";
  } else if (headers.has("cookie")) {
    return "request origin unknown";
  }

  // adapter-node gives a request with no length and no chunked encoding a null body.
  if (!isEndpoint(routeId) || request.body === null) return null;
  const contentType = headers.get("content-type");
  if (isJsonContentType(contentType)) return null;
  if (isAttachmentUpload(request.method, url.pathname, contentType)) return null;
  return "body must be sent as content-type: application/json";
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The routes that read a body as JSON: the proxy and the session endpoints, never a page's form
 * action. The route id keeps the groups, so `/(flows)/auth/login-link/[token]` (a page) is not one
 * of these. */
function isEndpoint(routeId: string | null): boolean {
  return routeId !== null && (routeId.startsWith("/api/") || routeId.startsWith("/auth/"));
}

const ATTACHMENT_PATH = /^\/api\/v1\/runs\/[^/]+\/attachments$/;

/** A run's image upload, which goes as the raw bytes under the image's own type. */
function isAttachmentUpload(method: string, path: string, contentType: string | null): boolean {
  const type = contentType?.split(";", 1)[0].trim().toLowerCase() ?? "";
  return method === "POST" && ATTACHMENT_PATH.test(path) &&
    (ATTACHMENT_MIMES as readonly string[]).includes(type);
}
