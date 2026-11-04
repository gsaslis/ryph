import { env } from "$env/dynamic/public";
import type { Cookies } from "@sveltejs/kit";
import { z } from "zod";
import { COMMON_COOKIE_OPTIONS } from "$lib/server/auth";
import { safeBackTo } from "$lib/utils/safe-path";

/**
 * What the token leg needs again from the authorize leg, where the provider asks for it: GitLab
 * requires the same `redirect_uri` on both legs, and checks the PKCE verifier against the
 * challenge the authorize URL carried. GitHub's leg takes neither, so its leg is null.
 */
export type OAuthLeg = { redirectUri: string; codeVerifier: string };

/** An authorize URL, without its state, and the leg the callback must hand back. */
export type Authorize = { url: URL; leg: OAuthLeg | null };

/** `RYPH_GITLAB_URL`'s app-side twin: the instance people sign in on, any path prefix kept. */
export const DEFAULT_GITLAB_URL = "https://gitlab.com";

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

/** A PKCE verifier (RFC 7636: 43 characters of base64url) and its S256 challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** The instance's base without a trailing slash, or null when it is not an http(s) URL. */
function gitlabBase(raw: string | undefined): string | null {
  const value = raw?.trim() || DEFAULT_GITLAB_URL;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * The providers this app can start an OAuth round trip with. The control plane decides which
 * of them sign people in; this side only knows where to send the browser.
 *
 * GitHub gets no `redirect_uri`: the App's registered callback URL brings the browser back to
 * `/github/callback`, the one origin it will honour anyway, and which the request itself cannot
 * be trusted to name behind a TLS-terminating proxy. GitLab REQUIRES one on both legs, so it is
 * built from `origin` (the adapter's, which honours `ORIGIN` behind a proxy) and pinned in the
 * state cookie so the token leg sends the very same string. GitLab's leg also carries PKCE.
 */
const providers: Record<string, (origin: string) => Promise<Authorize | null>> = {
  github: () => {
    const clientId = env.PUBLIC_GITHUB_CLIENT_ID;
    if (!clientId) return Promise.resolve(null);
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    return Promise.resolve({ url, leg: null });
  },
  gitlab: async (origin) => {
    const clientId = env.PUBLIC_GITLAB_CLIENT_ID;
    const base = gitlabBase(env.PUBLIC_GITLAB_URL);
    if (!clientId || base === null) return null;
    const redirectUri = `${origin}/gitlab/callback`;
    const { verifier, challenge } = await pkcePair();
    const url = new URL(`${base}/oauth/authorize`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "read_user");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return { url, leg: { redirectUri, codeVerifier: verifier } };
  },
};

/** The authorize URL for `provider`, without its state, or null when unknown or unconfigured.
 * `origin` is this app's own, which a provider that needs a `redirect_uri` builds it from. */
export async function authorizeUrl(provider: string, origin: string): Promise<Authorize | null> {
  return (await providers[provider]?.(origin)) ?? null;
}

export const OAUTH_STATE_COOKIE = "ryph_oauth_state";

const oauthStateSchema = z.object({
  state: z.string().min(1),
  provider: z.string().min(1),
  intent: z.enum(["login", "link"]),
  backTo: z.string().nullable(),
  /** An invite token the sign-in should redeem, when the round trip began on an invite page. */
  invite: z.string().nullable(),
  /** The authorize leg's redirect URI and PKCE verifier, where the provider needs them back.
   * The verifier never leaves this httpOnly cookie until the token leg. */
  leg: z.object({ redirectUri: z.string().min(1), codeVerifier: z.string().min(1) }).nullable(),
});
export type OAuthState = z.infer<typeof oauthStateSchema>;

/** Pins the round trip's CSRF state, intent and leg for the callback, and returns the state. */
export function beginOAuth(
  cookies: Cookies,
  input: {
    provider: string;
    intent: OAuthState["intent"];
    backTo: string | null;
    invite: string | null;
    leg: OAuthLeg | null;
  },
): string {
  const state = crypto.randomUUID();
  const value: OAuthState = { state, ...input, backTo: safeBackTo(input.backTo) };
  cookies.set(OAUTH_STATE_COOKIE, JSON.stringify(value), { ...COMMON_COOKIE_OPTIONS, maxAge: 600 });
  return state;
}

/** Reads and clears the pinned round trip; null when there is none or it does not parse. */
export function endOAuth(cookies: Cookies): OAuthState | null {
  const raw = cookies.get(OAUTH_STATE_COOKIE);
  cookies.delete(OAUTH_STATE_COOKIE, { path: "/" });
  if (!raw) return null;
  try {
    return oauthStateSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
