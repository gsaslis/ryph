import { json, type RequestHandler } from "@sveltejs/kit";
import { clearAuthCookies, revokeRefreshToken } from "$lib/server/auth";

export const POST: RequestHandler = async (event) => {
  const { locals } = event;
  if (locals.refreshToken) {
    // Best effort — clearing cookies logs the user out either way.
    await revokeRefreshToken(locals.refreshToken).catch(() => {});
  }

  clearAuthCookies(event);
  return json({ ok: true });
};
