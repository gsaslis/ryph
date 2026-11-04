import { error, redirect, type RequestHandler } from "@sveltejs/kit";
import { RYPH_API_URL, sessionHeaders } from "$lib/server/auth";
import { getUserData } from "$lib/utils/auth/jwt";

/**
 * "Manage installation" on a GitHub repo's page: a redirect to where its App installation is
 * managed on GitHub, which the control plane resolves only now, when the person clicks.
 *
 * Outside `/api/` on purpose, like `/images/…`: this is a page a person opens, so the server hook
 * refreshes an expired session on the way in, and the control plane's redirect is read here
 * rather than followed by a proxy.
 */
export const GET: RequestHandler = async (event) => {
  const { params, url, locals } = event;
  const backTo = `/login?backTo=${encodeURIComponent(url.pathname)}`;
  if (getUserData(locals.accessToken) === null) redirect(302, backTo);

  const target = new URL(
    `${RYPH_API_URL}/v1/connected-repos/${
      encodeURIComponent(params.id ?? "")
    }/installation-settings`,
  );
  const headers = new Headers({ authorization: `Bearer ${locals.accessToken}` });
  for (const [name, value] of Object.entries(sessionHeaders(event))) headers.set(name, value);

  const res = await fetch(target, { headers, redirect: "manual" });
  await res.body?.cancel();
  const location = res.headers.get("location");
  // Only ever on to an https page: the control plane checked the forge's answer, and this does
  // not become a way to send a browser anywhere else.
  if (res.status === 302 && location !== null && URL.canParse(location)) {
    const settings = new URL(location);
    if (settings.protocol === "https:") redirect(302, settings.href);
  }
  // The session ended between the hook's check and this read.
  if (res.status === 401) redirect(302, backTo);
  if (res.status === 403 || res.status === 404) {
    error(404, "This repository has no GitHub installation to manage.");
  }
  error(502, "GitHub did not answer. Try again in a moment.");
};
