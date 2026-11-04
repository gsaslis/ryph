// The `OpenAiAccounts` port over HTTP: auth.openai.com's token and revocation endpoints, its JWKS,
// and api.openai.com's model list. Every URL and the fetch are parameters, so the tests run the
// real verification against a fake OpenAI holding a locally generated key pair.
//
// Invariants:
// - a public client: no secret is ever sent, and the client id is the ISSUED one
// - every call is bounded (CALL_TIMEOUT_MS); a hung auth server must not hold a model call open
// - a failure says whether it is about the token (`transient: false`, with OpenAI's code) or
//   about reaching OpenAI (`transient: true`) — only the first may cost a key its sign-in
// - no token, code or verifier is ever put in an error message

import { createLocalJWKSet, errors as joseErrors, type JSONWebKeySet, jwtVerify } from "jose";
import {
  instantOf,
  OPENAI_ISSUER,
  OPENAI_JWKS_URL,
  OPENAI_REVOKE_URL,
  OPENAI_TOKEN_URL,
  PLAN_RESOURCE,
} from "../../core/chatgpt_plan.ts";
import {
  type IdentityClaims,
  OAuthError,
  type OpenAiAccounts,
  type TokenGrant,
} from "../../ports/openai_accounts.ts";

export interface OpenAiAccountsOptions {
  fetch?: typeof fetch;
  tokenUrl?: string;
  revokeUrl?: string;
  jwksUrl?: string;
  issuer?: string;
  /** Where `GET /models` is asked; the plan's resource by default. */
  apiBaseUrl?: string;
  now?: () => Date;
}

const CALL_TIMEOUT_MS = 15_000;
/** How long one reading of the JWKS is trusted before it is fetched again. */
const JWKS_TTL_MS = 60 * 60 * 1000;
/** The clock skew an ID token's times are allowed, as OpenAI's own example allows. */
const CLOCK_TOLERANCE_S = 5;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `expires_in` as positive seconds: a number, or a numeric string some servers send. */
function secondsOf(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The code of a token endpoint's refusal, in any of the shapes OpenAI answers with: the OAuth
 * `{"error":"invalid_grant"}`, the nested `{"error":{"code":"refresh_token_reused"}}`, or a
 * top-level `{"code":"refresh_token_expired"}`.
 */
function errorCodeOf(body: unknown): string | null {
  if (!isObject(body)) return null;
  if (typeof body.error === "string" && body.error !== "") return body.error;
  if (isObject(body.error) && typeof body.error.code === "string" && body.error.code !== "") {
    return body.error.code;
  }
  if (typeof body.code === "string" && body.code !== "") return body.code;
  return null;
}

export function openAiAccounts(opts: OpenAiAccountsOptions = {}): OpenAiAccounts {
  const doFetch = opts.fetch ?? fetch;
  const tokenUrl = opts.tokenUrl ?? OPENAI_TOKEN_URL;
  const revokeUrl = opts.revokeUrl ?? OPENAI_REVOKE_URL;
  const jwksUrl = opts.jwksUrl ?? OPENAI_JWKS_URL;
  const issuer = opts.issuer ?? OPENAI_ISSUER;
  const apiBaseUrl = (opts.apiBaseUrl ?? PLAN_RESOURCE).replace(/\/+$/, "");
  const now = opts.now ?? (() => new Date());

  /** One bounded call; a network failure or a timeout is a transient OAuthError. */
  const call = async (url: string, init: RequestInit, what: string): Promise<Response> => {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    } catch (err) {
      throw new OAuthError(
        `could not reach OpenAI for the ${what}: ${err instanceof Error ? err.name : "error"}`,
        null,
        true,
      );
    }
  };

  const form = (fields: Record<string, string>): RequestInit => ({
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(fields).toString(),
  });

  /** A token endpoint's answer, or the OAuthError it amounts to. */
  const grantOf = async (res: Response, what: string): Promise<TokenGrant> => {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Read below as "no body".
    }
    if (!res.ok) {
      const code = errorCodeOf(body);
      // A 5xx (or a 4xx with no code) says nothing about the token: try again later. A coded 4xx
      // is OpenAI's verdict on it, and so is any 401, which Codex treats as permanent too.
      const transient = res.status !== 401 &&
        (res.status >= 500 || res.status === 429 || code === null);
      throw new OAuthError(
        `OpenAI refused the ${what} (${res.status}${code === null ? "" : `, ${code}`})`,
        code,
        transient,
        res.status,
      );
    }
    if (!isObject(body) || typeof body.access_token !== "string" || body.access_token === "") {
      throw new OAuthError(`OpenAI's ${what} answer carried no access token`, null, true);
    }
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      idToken: typeof body.id_token === "string" ? body.id_token : null,
      expiresIn: secondsOf(body.expires_in),
      expiresAt: instantOf(body.expires_at),
      scope: typeof body.scope === "string" ? body.scope : null,
      earliestRefreshAt: instantOf(body.earliest_refresh_at),
    };
  };

  // The JWKS, read once and trusted for an hour, and read again at once when a token names a key
  // the cached set lacks — which is what a rotation looks like from here.
  let jwks: { set: ReturnType<typeof createLocalJWKSet>; freshUntilMs: number } | null = null;
  const loadJwks = async (): Promise<ReturnType<typeof createLocalJWKSet>> => {
    const res = await call(jwksUrl, { headers: { accept: "application/json" } }, "signing keys");
    if (!res.ok) {
      await res.body?.cancel();
      throw new OAuthError(`OpenAI's signing keys answered ${res.status}`, null, true);
    }
    const set = createLocalJWKSet(await res.json() as JSONWebKeySet);
    jwks = { set, freshUntilMs: now().getTime() + JWKS_TTL_MS };
    return set;
  };

  const verifyWith = async (
    keys: ReturnType<typeof createLocalJWKSet>,
    idToken: string,
    expect: { clientId: string; nonce: string },
  ) =>
    await jwtVerify(idToken, keys, {
      issuer,
      audience: expect.clientId,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat"],
      clockTolerance: CLOCK_TOLERANCE_S,
      currentDate: now(),
    });

  return {
    async exchangeCode({ clientId, code, verifier, redirectUri }) {
      const res = await call(
        tokenUrl,
        form({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource: PLAN_RESOURCE,
        }),
        "code exchange",
      );
      return await grantOf(res, "code exchange");
    },

    async refresh({ clientId, refreshToken }) {
      // No `scope`: omitting it keeps the grant as it was.
      const res = await call(
        tokenUrl,
        form({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: refreshToken,
          resource: PLAN_RESOURCE,
        }),
        "token refresh",
      );
      return await grantOf(res, "token refresh");
    },

    async revoke({ clientId, refreshToken }) {
      const res = await call(
        revokeUrl,
        form({ token: refreshToken, token_type_hint: "refresh_token", client_id: clientId }),
        "revocation",
      );
      await res.body?.cancel();
      if (!res.ok) {
        throw new OAuthError(`OpenAI refused the revocation (${res.status})`, null, true);
      }
    },

    async verifyIdToken(idToken, expect) {
      const cached = jwks !== null && jwks.freshUntilMs > now().getTime() ? jwks.set : null;
      let verified;
      try {
        verified = await verifyWith(cached ?? await loadJwks(), idToken, expect);
      } catch (err) {
        if (!(err instanceof joseErrors.JWKSNoMatchingKey) || cached === null) throw err;
        verified = await verifyWith(await loadJwks(), idToken, expect);
      }
      const { payload } = verified;
      if (payload.nonce !== expect.nonce) throw new Error("the ID token's nonce does not match");
      if (typeof payload.sub !== "string" || payload.sub === "") {
        throw new Error("the ID token carries no subject");
      }
      const auth = payload["https://api.openai.com/auth"];
      const claims: IdentityClaims = {
        sub: payload.sub,
        email: typeof payload.email === "string" ? payload.email : null,
        planType: isObject(auth) && typeof auth.chatgpt_plan_type === "string"
          ? auth.chatgpt_plan_type
          : null,
      };
      return claims;
    },

    async listModels(accessToken) {
      const res = await call(`${apiBaseUrl}/models`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      }, "model list");
      if (!res.ok) {
        await res.body?.cancel();
        throw new OAuthError(`OpenAI's model list answered ${res.status}`, null, res.status >= 500);
      }
      return await res.json();
    },
  };
}
