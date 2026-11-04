// OpenAI's account endpoints, as a ChatGPT plan key needs them: the code exchange, the refresh,
// the revocation, verifying an ID token, and the account's model list. The one adapter speaks
// HTTP to auth.openai.com and api.openai.com (adapters/openai/accounts.ts); tests drive it
// against a fake with a locally generated JWKS, and the core never sees a URL.

/** What a token endpoint answered with, normalized. */
export interface TokenGrant {
  accessToken: string;
  /** Absent only on a refresh that did not rotate it, which OpenAI's does not do. */
  refreshToken: string | null;
  idToken: string | null;
  /** Seconds. */
  expiresIn: number | null;
  /** ISO-8601: the response's `expires_at`, when it sent one instead of (or beside) `expires_in`. */
  expiresAt: string | null;
  /** Space-separated, as sent. */
  scope: string | null;
  /** ISO-8601, when the response said. */
  earliestRefreshAt: string | null;
}

/** The claims a verified ID token is used for. */
export interface IdentityClaims {
  sub: string;
  email: string | null;
  /** `https://api.openai.com/auth` → `chatgpt_plan_type`, when present. Not in OpenAI's SIWC
   * docs; read best effort for the key list. */
  planType: string | null;
}

/**
 * An OAuth error from OpenAI, or the could-not-ask kind. `code` is the machine-readable `error`
 * field when there was one; `transient` says the failure is worth retrying (network, 5xx) and
 * says nothing about the token itself. `status` is the HTTP status OpenAI answered with, null when
 * it was not reached.
 */
export class OAuthError extends Error {
  override readonly name = "OAuthError";
  constructor(
    message: string,
    readonly code: string | null,
    readonly transient: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export interface OpenAiAccounts {
  exchangeCode(input: {
    clientId: string;
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<TokenGrant>;
  refresh(input: { clientId: string; refreshToken: string }): Promise<TokenGrant>;
  /** Ends the renewable session. Resolves on OpenAI's 200, which an already-dead token gets too. */
  revoke(input: { clientId: string; refreshToken: string }): Promise<void>;
  /** Signature against OpenAI's JWKS, issuer, audience = `clientId`, expiry, and `nonce`. Throws
   * on any of them. */
  verifyIdToken(idToken: string, expect: { clientId: string; nonce: string }): Promise<
    IdentityClaims
  >;
  /** `GET /v1/models` with the access token, the body as JSON. */
  listModels(accessToken: string): Promise<unknown>;
}
