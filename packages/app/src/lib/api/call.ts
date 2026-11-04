import { browser } from "$app/environment";
import { invalidateAll } from "$app/navigation";
import { logOut, refreshSession } from "$lib/utils/auth/auth";

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function parseBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * A gateway saying it could not reach what is behind it, which says nothing about the request.
 * A 500 does — something upstream read the request and broke on it — and repeating that is asking
 * the same broken question twice.
 */
const TRANSIENT = new Set([502, 503, 504]);

/**
 * How long to wait before the one retry a read gets. Short enough that nobody watches it, long
 * enough to be on the other side of a pod being replaced — and jittered, because a page makes
 * several of these at once and a fixed wait would land them all back on the same instant.
 */
export const RETRY_MS = 400;
const pause = () => new Promise((r) => setTimeout(r, RETRY_MS + Math.random() * RETRY_MS));

/** One trip through the proxy, with the JSON content type the control plane expects. */
function attempt(f: typeof fetch, path: string, options: RequestInit): Promise<Response> {
  return f(`/api${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
  });
}

/**
 * A read, and — when the first trip came back a gateway failure or did not arrive at all — one
 * more after a short wait.
 *
 * ONLY a GET, because only a GET can be repeated without meaning something different the second
 * time: a POST that times out may well have happened, and sending it again is how one message
 * becomes two. And only once: this is here for the pod that was being replaced while the page
 * asked, not to paper over a control plane that is down. The task page re-runs its whole load
 * every three seconds while a run is live, so one unlucky read there used to take the page to the
 * error screen — with the next poll, three seconds later, about to succeed.
 */
async function read(f: typeof fetch, path: string, options: RequestInit): Promise<Response> {
  const method = (options.method ?? "GET").toUpperCase();
  if (method !== "GET") return await attempt(f, path, options);
  try {
    const res = await attempt(f, path, options);
    if (!TRANSIENT.has(res.status)) return res;
  } catch {
    // The request never landed — no DNS, no socket, a connection cut mid-flight. Indistinguishable
    // from the above from here, and answered the same way. A second failure throws, as it should.
  }
  await pause();
  return await attempt(f, path, options);
}

/**
 * Sends one request through the app's same-origin `/api` proxy, which attaches the bearer token
 * from the httpOnly auth cookies. Works with both the client fetch and a load function's `fetch`.
 *
 * In the browser, a 401 triggers a (deduped) cookie refresh and a single retry; if the refresh
 * fails, the user is logged out. The answer comes back unread: the two callers below read it as
 * JSON or as text.
 */
async function send(
  f: typeof fetch,
  path: string,
  options: RequestInit,
  refreshOnUnauthorized: boolean,
): Promise<Response> {
  const res = await read(f, path, options);

  if (res.status === 401 && refreshOnUnauthorized) {
    const user = await refreshSession();
    if (user) return send(f, path, options, false);

    // Refresh token is gone — drop the session so guards kick in.
    await logOut();
    await invalidateAll();
  }
  return res;
}

/** A refusal as an `ApiError`: the control plane's own `{error}` words when it sent them. Exported
 * for the one caller that does not go through `fetch` (an image upload, which reports progress). */
export function apiError(status: number, body: unknown): ApiError {
  const message =
    body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `request failed (${status})`;
  return new ApiError(status, body, message);
}

const failure = (res: Response, body: unknown): ApiError => apiError(res.status, body);

/** Calls the control plane and reads the answer as JSON; a non-2xx throws an `ApiError`. */
export async function apiCall(
  f: typeof fetch,
  path: string,
  options: RequestInit = {},
  refreshOnUnauthorized = browser,
): Promise<unknown> {
  const res = await send(f, path, options, refreshOnUnauthorized);
  const body = await parseBody(res);
  if (!res.ok) throw failure(res, body);
  return body;
}

/**
 * The same call for a route that answers `text/plain` — a build log. Its errors are still JSON,
 * so a refusal reads exactly as it does from `apiCall`.
 */
export async function apiText(
  f: typeof fetch,
  path: string,
  options: RequestInit = {},
  refreshOnUnauthorized = browser,
): Promise<string> {
  const res = await send(f, path, options, refreshOnUnauthorized);
  if (!res.ok) throw failure(res, await parseBody(res));
  return await res.text();
}
