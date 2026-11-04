import { browser } from "$app/environment";
import type { SessionUser } from "./jwt";

let loggingOut = false;

// Dedupes concurrent refresh attempts. The backend rotates refresh tokens, so
// parallel calls would otherwise race and the losers would be logged out.
export type SessionReadiness = "ready" | "auth-required" | "unavailable";

type RefreshResult =
  | { status: "ready"; user: SessionUser }
  | { status: "auth-required" | "unavailable"; user: null };

let refreshInFlight: Promise<RefreshResult> | null = null;

/**
 * Asks the app server to refresh the auth cookies (both httpOnly). Returns
 * the refreshed session user, or null if the refresh token is gone/expired.
 * Has no side effects beyond the rotated cookies — callers decide how to
 * handle failure.
 */
export async function refreshSession(): Promise<SessionUser | null> {
  return (await refreshSessionResult()).user;
}

function refreshSessionResult(): Promise<RefreshResult> {
  if (browser && loggingOut) return Promise.resolve({ status: "unavailable", user: null });
  if (browser && refreshInFlight) return refreshInFlight;

  const promise = (async (): Promise<RefreshResult> => {
    try {
      const res = await fetch("/auth/refresh", { method: "POST" });
      if (!res.ok) {
        return {
          status: res.status === 401 || res.status === 403 ? "auth-required" : "unavailable",
          user: null,
        };
      }
      const data = await res.json();
      const user = (data.user ?? null) as SessionUser | null;
      if (user === null) return { status: "unavailable", user: null };
      noteSessionExpiry(data.expiresIn);
      return { status: "ready", user };
    } catch {
      return { status: "unavailable", user: null };
    }
  })();

  if (browser) {
    refreshInFlight = promise;
    promise.finally(() => {
      if (refreshInFlight === promise) refreshInFlight = null;
    });
  }

  return promise;
}

export async function logOut() {
  noteSessionExpiry(null);
  if (browser) loggingOut = true;
  try {
    await fetch("/auth/logout", { method: "POST" });
  } finally {
    if (browser) loggingOut = false;
  }
}

/**
 * How long before the access token stops being accepted a frame is placed only after a refresh.
 * The server already stops accepting it 30 seconds early (see `getUserData`); this leaves the
 * frame's own request time to land, and covers a lazy frame mounted just before the edge.
 */
export const SESSION_MARGIN_MS = 20_000;

/** When, on `performance.now()`'s clock, the access token stops being accepted; null unknown. */
let sessionValidUntil: number | null = null;
/** Refresh credentials were explicitly rejected: wait until the server says something new. */
let sessionGone = false;

/**
 * Records how many seconds the server will still accept the access token for (`sessionSecondsLeft`),
 * as the root layout and `/auth/refresh` report it. Counted on this tab's own monotonic clock, so a
 * skewed wall clock does not matter. Null forgets it.
 */
export function noteSessionExpiry(secondsLeft: unknown): void {
  sessionGone = false;
  sessionValidUntil = typeof secondsLeft === "number" && Number.isFinite(secondsLeft)
    ? performance.now() + secondsLeft * 1000
    : null;
}

/**
 * Makes sure the session will outlast a request the browser is about to make without going
 * through `apiCall`: an artifact frame's document, whose route answers 401 and never refreshes.
 * Refreshes (deduplicated with every other refresh) when the token runs out within
 * `SESSION_MARGIN_MS`, and says whether there is a session to make it with. An unknown expiry is
 * trusted as it is: the request finds out, and a full frame asks `renewSession` then.
 */
export async function ensureFreshSession(): Promise<boolean> {
  return await ensureFreshSessionResult() === "ready";
}

/** Like ensureFreshSession, but distinguishes rejected credentials from temporary failure. */
export async function ensureFreshSessionResult(): Promise<SessionReadiness> {
  if (sessionValidUntil === null) return "ready";
  if (sessionValidUntil - performance.now() > SESSION_MARGIN_MS) return "ready";
  if (sessionGone) return "auth-required";
  return await renewSessionResult();
}

/**
 * A request was refused for want of a session: refresh once, deduplicated, and say whether there
 * is one again.
 */
export async function renewSession(): Promise<boolean> {
  return await renewSessionResult() === "ready";
}

/** Shares refresh rotation with all callers. Only HTTP 401/403 means sign-in is required. */
export async function renewSessionResult(): Promise<SessionReadiness> {
  const result = await refreshSessionResult();
  if (result.status === "auth-required") sessionGone = true;
  return result.status;
}
