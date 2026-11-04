import { redirect } from "@sveltejs/kit";
import { z } from "zod";
import type { PageServerLoad } from "./$types";
import { RYPH_API_URL, sessionHeaders, setAuthCookies, tokenPairSchema } from "$lib/server/auth";
import { endOAuth } from "$lib/server/oauth";
import { oauthFailure } from "$lib/server/oauth-failure";

/**
 * The provider's OAuth redirect lands here with `?code&state`. The state must match the
 * httpOnly cookie the start route pinned (the CSRF check); the intent pinned beside it decides
 * what the code becomes. Either way the code is exchanged server-side by the control plane —
 * the App's client secret lives behind it, never here.
 */
export const load: PageServerLoad = async (event) => {
  const { params, url, cookies, locals } = event;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const pinned = endOAuth(cookies);

  const failed = (error: string, linkRequired = false) => ({
    intent: pinned?.intent ?? "login",
    login: null,
    error,
    linkRequired,
  });
  if (!code) return failed("The provider did not send an authorization code.");
  if (!pinned || !state || pinned.state !== state || pinned.provider !== params.provider) {
    return failed("The sign-in attempt could not be verified (state mismatch). Please try again.");
  }
  if (pinned.intent === "link" && !locals.accessToken) {
    redirect(302, `/login?backTo=${encodeURIComponent("/account")}`);
  }

  const res = await fetch(`${RYPH_API_URL}/v1/auth/oauth/${params.provider}/callback`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...sessionHeaders(event),
      ...(pinned.intent === "link" ? { authorization: `Bearer ${locals.accessToken}` } : {}),
    },
    // GitLab's token leg needs the authorize leg's redirect URI and PKCE verifier back.
    body: JSON.stringify({
      code,
      ...(pinned.invite ? { invite: pinned.invite } : {}),
      ...(pinned.leg ?? {}),
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const failure = oauthFailure(params.provider, res.status, body);
    return failed(failure.error, failure.linkRequired);
  }

  if (pinned.intent === "link") {
    const { identity } = z.object({ identity: z.object({ login: z.string() }) }).parse(body);
    return { intent: "link" as const, login: identity.login, error: null, linkRequired: false };
  }
  setAuthCookies(event, tokenPairSchema.parse(body));
  redirect(303, pinned.backTo ?? "/agents");
};
