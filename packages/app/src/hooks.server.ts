import type { Handle, HandleServerError, ServerInit } from "@sveltejs/kit";
import {
  checkProxySecret,
  clearAuthCookies,
  readAuthCookies,
  refreshTokenPair,
  sessionAlive,
  sessionHeaders,
  setAuthCookies,
} from "$lib/server/auth";
import { getUserData, isSessionToken } from "$lib/utils/auth/jwt";
import { isImmutableAsset, serveAssetFromFallback } from "$lib/server/asset-fallback";
import { env } from "$env/dynamic/private";
import { describeError } from "$lib/utils/page-error";
import { crossOriginWriteRefusal } from "$lib/server/csrf";
import {
  ARTIFACT_CONTENT_PATH,
  ARTIFACT_THUMBNAIL_PATH,
  withAppGuards,
} from "$lib/server/app-guards";

// Before the first request: a server without the proxy secret should not come up at all.
export const init: ServerInit = () => checkProxySecret();

export const handleError: HandleServerError = ({ error, status, message }) =>
  describeError(error, status, message);

export const handle: Handle = async ({ event, resolve }) => {
  // Before anything reads a cookie: a write that cannot show it comes from this app's own pages
  // goes no further. See `crossOriginWriteRefusal`.
  const refused = crossOriginWriteRefusal(event.request, event.url, event.route.id);
  if (refused !== null) {
    return withAppGuards(
      event.url.pathname,
      new Response(JSON.stringify({ error: refused }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
  }
  return withAppGuards(event.url.pathname, await handleRequest({ event, resolve }));
};

const handleRequest: Handle = async ({ event, resolve }) => {
  // A built chunk that reached the hook is one this image does not have: adapter-node serves the
  // ones it does before we run. During a rollout that means a page from the other build is
  // asking, so look the chunk up in the bucket every build publishes to rather than 404 it.
  //
  // It only reaches here at all because of `reroute` in src/hooks.ts. Without it SvelteKit answers
  // every unmatched `/_app/` path with its own 404 before any hook runs, and this branch is dead
  // code — which is exactly how it shipped the first time. `event.url` is still the path the
  // browser asked for; the reroute changes only what SvelteKit routes on.
  if (isImmutableAsset(event.url.pathname)) {
    return serveAssetFromFallback(event.url.pathname, {
      baseUrl: env.RYPH_ASSET_FALLBACK_URL,
      acceptEncoding: event.request.headers.get("accept-encoding"),
      // Both halves or neither: a half-configured key would sign every request wrongly and the
      // store would answer 403, which reads exactly like a missing chunk and hides the cause.
      credentials: env.RYPH_ASSET_ACCESS_KEY_ID && env.RYPH_ASSET_SECRET_ACCESS_KEY
        ? {
          accessKeyId: env.RYPH_ASSET_ACCESS_KEY_ID,
          secretAccessKey: env.RYPH_ASSET_SECRET_ACCESS_KEY,
          region: env.RYPH_ASSET_REGION || "auto",
        }
        : undefined,
    });
  }

  // Only a session's token counts as the session cookie, here and so everywhere after: the proxy,
  // SSR loads, previews, artifacts and images all read `locals.accessToken`. Anything else in the
  // cookie (an API token's exchanged access token, put there by its holder, or junk) is no
  // session at all, so the request carries on as anonymous, or refreshes if it can.
  const { access: cookieToken, refresh: refreshToken } = readAuthCookies(event);
  const accessToken = isSessionToken(cookieToken) ? cookieToken : undefined;

  // For API proxy and auth endpoints, just expose the cookies as-is. Expired
  // access tokens surface as 401s that the client-side fetch wrapper handles
  // by refreshing — refreshing here too would double-rotate the refresh token.
  // Artifact content and thumbnails are the same: they load side by side, and each refreshing here
  // would race the others to rotate the one refresh token. It answers 401 instead.
  const passthrough = event.url.pathname.startsWith("/api/") ||
    event.url.pathname.startsWith("/auth/") ||
    ARTIFACT_CONTENT_PATH.test(event.url.pathname) ||
    ARTIFACT_THUMBNAIL_PATH.test(event.url.pathname);

  if (passthrough) {
    event.locals.accessToken = accessToken;
    event.locals.refreshToken = refreshToken;
    return resolve(event);
  }

  if (refreshToken) {
    if (accessToken && getUserData(accessToken)) {
      // The token is valid on its face; the session behind it may have been ended from another
      // browser. One round trip per page load keeps "end session" immediate rather than
      // "within ten minutes".
      if (await sessionAlive(accessToken)) {
        event.locals.accessToken = accessToken;
        event.locals.refreshToken = refreshToken;
      } else {
        // Gone, or minted before the control plane learned to say: the refresh tells them
        // apart, since a session that was really ended refuses it.
        try {
          const pair = await refreshTokenPair(refreshToken, sessionHeaders(event));
          setAuthCookies(event, pair);
          event.locals.accessToken = pair.accessToken;
          event.locals.refreshToken = pair.refreshToken;
        } catch {
          clearAuthCookies(event);
        }
      }
    } else {
      // Access token missing/expired — refresh before rendering, so SSR loads
      // and their internal /api fetches see fresh cookies.
      try {
        const pair = await refreshTokenPair(refreshToken, sessionHeaders(event));
        setAuthCookies(event, pair);
        event.locals.accessToken = pair.accessToken;
        event.locals.refreshToken = pair.refreshToken;
      } catch {
        // Refresh failed (expired/revoked) — continue as anonymous.
        clearAuthCookies(event);
      }
    }
  }

  return resolve(event);
};
