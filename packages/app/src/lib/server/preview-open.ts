import type { RequestEvent } from "@sveltejs/kit";
import { RYPH_API_URL, sessionHeaders } from "$lib/server/auth";
import { getUserData } from "$lib/utils/auth/jwt";
import { openablePreviewUrl } from "$lib/utils/previews";

/** A redirect nothing keeps: the answer is a one-time way in. */
export function go(location: string, status = 303): Response {
  return new Response(null, {
    status,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

/**
 * The open routes' one body. Asks the control plane, as the signed-in person, for a way into
 * `previewId` at its open route `api` (a one-time ticket on the preview's own origin when hosted,
 * the preview itself on the local binary), passing on the query parameters `passOn` names as this
 * URL has them, and sends the tab there. Someone not signed in goes to sign in and comes back
 * here; whatever else goes wrong, the tab goes to `back`, and the upstream's answer is never shown.
 */
export async function openPreview(
  event: RequestEvent,
  api: string,
  previewId: string,
  back: string,
  passOn: readonly string[],
): Promise<Response> {
  const { url, locals } = event;
  const signIn = `/login?backTo=${encodeURIComponent(url.pathname + url.search)}`;
  if (getUserData(locals.accessToken) === null) return go(signIn, 302);

  const target = new URL(`${RYPH_API_URL}${api}`);
  for (const name of passOn) {
    const value = url.searchParams.get(name);
    if (value) target.searchParams.set(name, value);
  }
  const headers = new Headers({ authorization: `Bearer ${locals.accessToken}` });
  for (const [name, value] of Object.entries(sessionHeaders(event))) headers.set(name, value);

  let location: string | null = null;
  try {
    const res = await fetch(target, { method: "POST", headers });
    // The session ended between the hook's check and this call.
    if (res.status === 401) {
      await res.body?.cancel();
      return go(signIn, 302);
    }
    if (res.status === 200) {
      const body: unknown = await res.json().catch(() => null);
      location = openablePreviewUrl(
        body !== null && typeof body === "object" ? (body as { url?: unknown }).url : null,
        previewId,
      );
    } else {
      await res.body?.cancel();
    }
  } catch {
    // The control plane could not be reached; the tab goes back like any other failure.
  }
  return go(location ?? back);
}
