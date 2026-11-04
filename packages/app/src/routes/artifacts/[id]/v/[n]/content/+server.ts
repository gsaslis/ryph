import type { RequestHandler } from "@sveltejs/kit";
import { RYPH_API_URL, sessionHeaders } from "$lib/server/auth";
import { artifactContentHeaders, artifactNotice } from "$lib/server/artifact-content";
import { getUserData } from "$lib/utils/auth/jwt";
import { artifactHref, parseVersion } from "$lib/utils/artifacts";

/** A notice in place of the page, under the same guards as the page itself. */
function refuse(status: number, message: string): Response {
  const notice = artifactNotice(message, { signIn: status === 401 });
  return new Response(notice, { status, headers: artifactContentHeaders() });
}

/**
 * One version of an artifact's HTML, which its frame loads: `/artifacts/<id>/v/<n>/content`.
 *
 * Only ever as a frame's document: anything else (the address typed into a tab, a link, a popup
 * the page opened) is sent to the artifact's page, which shows it inside the guarded frame.
 *
 * Read from the control plane as the signed-in person, and answered with this server's own
 * headers rather than whatever came back. The hook passes this
 * route through without refreshing the session, so frames loading side by side never rotate the
 * refresh token; a missing or expired access token is a 401 here, never a redirect. Its notice
 * tells the page around the frame, which refreshes the session (once, shared with every other
 * refresh) and loads the frame again; the page is also what signs a person in again. An artifact this person cannot read is a 404,
 * the same as one that is not there.
 */
export const GET: RequestHandler = async (event) => {
  const { params, locals, request } = event;
  const version = parseVersion(params.n);

  if (request.headers.get("sec-fetch-dest") !== "iframe") {
    const page = artifactHref(params.id ?? "", version ?? undefined);
    return new Response(null, {
      status: 302,
      headers: { location: page, "cache-control": "no-store" },
    });
  }

  if (getUserData(locals.accessToken) === null) return refuse(401, "Sign in to see this page.");
  if (version === null) return refuse(404, "This page is not available.");

  const target = new URL(
    `${RYPH_API_URL}/v1/artifacts/${
      encodeURIComponent(params.id ?? "")
    }/versions/${version}/content`,
  );
  const headers = new Headers({ authorization: `Bearer ${locals.accessToken}` });
  for (const [name, value] of Object.entries(sessionHeaders(event))) headers.set(name, value);
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch !== null) headers.set("if-none-match", ifNoneMatch);

  let res: Response;
  try {
    res = await fetch(target, { headers });
  } catch {
    return refuse(502, "This page could not be loaded.");
  }
  if (res.status !== 200) await res.body?.cancel();
  if (res.status === 401) return refuse(401, "Sign in to see this page.");
  if (res.status === 403 || res.status === 404) return refuse(404, "This page is not available.");

  const out = artifactContentHeaders();
  const etag = res.headers.get("etag");
  if (etag !== null) out.set("etag", etag);
  if (res.status === 304) {
    out.delete("content-type");
    return new Response(null, { status: 304, headers: out });
  }
  if (res.status !== 200) return refuse(502, "This page could not be loaded.");
  return new Response(res.body, { status: 200, headers: out });
};
