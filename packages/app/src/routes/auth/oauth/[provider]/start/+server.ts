import { error, redirect, type RequestHandler } from "@sveltejs/kit";
import { authorizeUrl, beginOAuth } from "$lib/server/oauth";

/**
 * Kicks off an OAuth round trip with a provider. `intent=login` signs in (or registers, when
 * the instance admits); `intent=link` attaches the account to the signed-in user. The intent
 * is pinned in the state cookie, never trusted from the callback's query.
 */
export const GET: RequestHandler = async ({ params, url, cookies, locals }) => {
  const provider = params.provider ?? "";
  const authorize = await authorizeUrl(provider, url.origin);
  if (!authorize) error(404, `${provider} sign-in is not configured`);

  const intent = url.searchParams.get("intent") === "link" ? "link" : "login";
  if (intent === "link" && !locals.accessToken) error(401, "sign in first");

  const state = beginOAuth(cookies, {
    provider,
    intent,
    backTo: url.searchParams.get("backTo"),
    invite: intent === "login" ? url.searchParams.get("invite") : null,
    leg: authorize.leg,
  });
  authorize.url.searchParams.set("state", state);
  redirect(302, authorize.url.toString());
};
