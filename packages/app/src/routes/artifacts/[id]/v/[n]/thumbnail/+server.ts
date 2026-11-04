import type { RequestHandler } from "@sveltejs/kit";
import { RYPH_API_URL, sessionHeaders } from "$lib/server/auth";
import { getUserData } from "$lib/utils/auth/jwt";
import { parseVersion } from "$lib/utils/artifacts";

function thumbnailHeaders(): Headers {
  return new Headers({
    "cache-control": "private, no-cache",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
  });
}

/** Image requests never redirect or rotate the shared session's refresh token. */
export const GET: RequestHandler = async (event) => {
  const { params, locals, request } = event;
  const refuse = (status: number) => new Response(null, { status, headers: thumbnailHeaders() });
  if (getUserData(locals.accessToken) === null) return refuse(401);
  const version = parseVersion(params.n);
  if (version === null) return refuse(404);

  const target = new URL(
    `${RYPH_API_URL}/v1/artifacts/${
      encodeURIComponent(params.id ?? "")
    }/versions/${version}/thumbnail`,
  );
  const headers = new Headers({ authorization: `Bearer ${locals.accessToken}` });
  for (const [name, value] of Object.entries(sessionHeaders(event))) headers.set(name, value);
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch !== null) headers.set("if-none-match", ifNoneMatch);

  let res: Response;
  try {
    res = await fetch(target, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  } catch {
    return refuse(502);
  }
  if (res.status !== 200) await res.body?.cancel();
  if (res.status === 401) return refuse(401);
  if (res.status === 403 || res.status === 404) return refuse(404);
  // A busy renderer is temporary; visible cards retry only a bounded number of times.
  if (res.status === 503) return refuse(503);
  if (res.status !== 200 && res.status !== 304) return refuse(502);

  const out = thumbnailHeaders();
  const etag = res.headers.get("etag");
  if (etag !== null) out.set("etag", etag);
  if (res.status === 304) return new Response(null, { status: 304, headers: out });
  if (res.headers.get("content-type")?.split(";")[0] !== "image/png") {
    await res.body?.cancel();
    return refuse(502);
  }
  out.set("content-type", "image/png");
  return new Response(res.body, { headers: out });
};
