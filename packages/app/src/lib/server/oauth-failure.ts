import { providerLabel } from "$lib/utils/providers";

export type OAuthFailure = { error: string; linkRequired: boolean };

/**
 * What the callback page says when the control plane refuses a provider code. A sign-in that
 * matched an account by address alone, where that account must link the provider itself,
 * gets its own plain answer rather than the server's wording.
 */
export function oauthFailure(provider: string, status: number, body: unknown): OAuthFailure {
  const fields = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  if (fields.code === "link_required") {
    const label = providerLabel(provider);
    return {
      error: `This ${label} account isn't linked to an account here yet. Sign in another way, ` +
        `then link ${label} on your account page.`,
      linkRequired: true,
    };
  }
  return {
    error: typeof fields.error === "string" ? fields.error : `the sign-in failed (${status})`,
    linkRequired: false,
  };
}
