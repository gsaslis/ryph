import { error, redirect, type RequestHandler } from "@sveltejs/kit";
import { RYPH_API_URL, sessionHeaders } from "$lib/server/auth";
import { getUserData } from "$lib/utils/auth/jwt";
import { forwardedResponseHeaders } from "../../../api/[...path]/path";

/**
 * An image an agent put in what it wrote, at the link a forge comment or a chat post carries
 * instead of the image itself: `/images/<runId>/<attachmentId>`.
 *
 * Nothing about the link grants anything. It is the run's attachment behind the same login and
 * the same read access as the run page, so a person who follows it from GitHub without a session
 * signs in and comes back here, and one who cannot read the run gets a 404. The bytes and their
 * guarding headers (nosniff, the sandbox CSP, `private, no-cache`) are the control plane's, as
 * the session proxy forwards them.
 *
 * Outside `/api/` on purpose: the server hook refreshes an expired session on the way in for
 * every other path, and this is a page a person opens, not a call a page makes.
 */
export const GET: RequestHandler = async (event) => {
  const { params, url, locals } = event;
  const backTo = `/login?backTo=${encodeURIComponent(url.pathname)}`;
  if (getUserData(locals.accessToken) === null) redirect(302, backTo);

  const target = new URL(
    `${RYPH_API_URL}/v1/runs/${encodeURIComponent(params.runId ?? "")}/attachments/${
      encodeURIComponent(params.attachmentId ?? "")
    }`,
  );
  const headers = new Headers({ authorization: `Bearer ${locals.accessToken}` });
  for (const [name, value] of Object.entries(sessionHeaders(event))) headers.set(name, value);

  const res = await fetch(target, { headers });
  if (!res.ok) await res.body?.cancel();
  // The session ended between the hook's check and this read.
  if (res.status === 401) redirect(302, backTo);
  // Not this person's to see and not there read the same, as the control plane answers them.
  if (res.status === 403 || res.status === 404) error(404, "This image is not available.");
  if (!res.ok) error(502, "The image could not be loaded.");

  return new Response(res.body, {
    status: res.status,
    headers: forwardedResponseHeaders(res.headers),
  });
};
