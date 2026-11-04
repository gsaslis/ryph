import { error, json, type RequestHandler } from "@sveltejs/kit";
import {
  clearAuthCookies,
  refreshTokenPair,
  sessionHeaders,
  setAuthCookies,
  UpstreamAuthError,
} from "$lib/server/auth";
import { sessionSecondsLeft } from "$lib/utils/auth/jwt";

export const POST: RequestHandler = async (event) => {
  const { locals } = event;
  const refreshToken = locals.refreshToken;
  if (!refreshToken) error(401, "unauthorized");

  try {
    const pair = await refreshTokenPair(refreshToken, sessionHeaders(event));
    setAuthCookies(event, pair);
    // How long the new access token lasts, which the browser counts down to refresh before a frame
    // (whose content route never refreshes) would load with it too late.
    return json({ user: pair.user, expiresIn: sessionSecondsLeft(pair.accessToken) });
  } catch (cause) {
    if (cause instanceof UpstreamAuthError && (cause.status === 401 || cause.status === 403)) {
      clearAuthCookies(event);
      error(401, "unauthorized");
    }
    // An unreachable auth service, throttling, or a malformed reply is not a sign-out. Keep
    // both cookies so a subsequent, deduplicated browser refresh can recover the session.
    error(503, "session refresh temporarily unavailable");
  }
};
